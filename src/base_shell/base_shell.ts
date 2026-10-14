import { PromiseDelegate, UUID } from '@lumino/coreutils';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';
import coincident from 'coincident/main';
import { proxy, wrap } from 'comlink';
import { ExternalCommands } from './external_commands';
import { MainIOManager } from './main_io_manager';
import { ansi } from '../ansi';
import type { IOutputCallback } from '../callback';
import type { ISize } from '../callback';
import type { ICoincidentShellWorker } from '../coincident_shell_worker';
import type { IComlinkShellWorker } from '../comlink_shell_worker';
import type { IShell } from '../defs';
import type { IShellWorker, WorkerType } from '../defs_internal';
import { DownloadTracker } from '../download_tracker';

/**
 * Abstract base class for Shell that external libraries use.
 * It communicates with the real shell that runs in a web worker.
 */
export abstract class BaseShell implements IShell {
  constructor(options: IShell.IOptions) {
    this._shellId = options.shellId ?? UUID.uuid4();

    if (options.shellManager !== undefined) {
      options.shellManager.registerShell(
        this._shellId,
        this,
        this._mainIOManager.handleServiceWorkerStdin.bind(this._mainIOManager)
      );
    }

    this._outputCallback = options.outputCallback;

    this._initialize(options);
  }

  get commandStateChanged(): ISignal<this, IShell.ICommandStateChangedArgs> {
    return this._commandStateChanged;
  }

  protected createRemote(
    options: IShell.IOptions & { worker: Worker }
  ): ICoincidentShellWorker | IComlinkShellWorker {
    const { worker } = options;
    if (this.workerType === 'coincident') {
      const remote = (worker as any).proxy as ICoincidentShellWorker;

      remote.callExternalCommand = this._externalCommands.callExternalCommand.bind(
        this._externalCommands
      );
      remote.callExternalTabComplete = this._externalCommands.callExternalTabComplete.bind(
        this._externalCommands
      );
      remote.commandStateChangedCallback = this._commandStateChangedCallback.bind(this);
      remote.downloadModuleCallback = this._downloadWasmModuleCallback.bind(this);
      remote.enableBufferedStdinCallback = this._enableBufferedStdinCallback.bind(this);
      remote.externalInputReturn = this._externalCommands.handleInputReturn.bind(
        this._externalCommands
      );
      remote.outputCallback = options.outputCallback.bind(this);
      remote.setMainIOCallback = this._mainIOManager.setMainIO.bind(this._mainIOManager);
      remote.terminateCallback = this.dispose.bind(this);
      if (options.wasmUrlQueryParams !== undefined) {
        remote.wasmUrlQueryParamsCallback = options.wasmUrlQueryParams.bind(this);
      } else {
        // Cannot set undefined, coincident needs it to be a function.
        remote.wasmUrlQueryParamsCallback = filename => {
          return {};
        };
      }

      return remote;
    } else {
      const remote = wrap(worker) as IComlinkShellWorker;

      remote.registerCallbacks(
        proxy(this._externalCommands.callExternalCommand.bind(this._externalCommands)),
        proxy(this._externalCommands.callExternalTabComplete.bind(this._externalCommands)),
        proxy(this._commandStateChangedCallback.bind(this)),
        proxy(this._downloadWasmModuleCallback.bind(this)),
        proxy(this._enableBufferedStdinCallback.bind(this)),
        proxy(this._externalCommands.handleInputReturn.bind(this._externalCommands)),
        proxy(options.outputCallback),
        proxy(this._mainIOManager.setMainIO.bind(this._mainIOManager)),
        proxy(this.dispose.bind(this)), // terminateCallback
        options.wasmUrlQueryParams !== undefined ? proxy(options.wasmUrlQueryParams) : undefined
      );

      return remote;
    }
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    console.log('Cockle Shell disposed');
    this._isDisposed = true;

    this._remote = undefined;
    this._worker!.terminate();

    if (this._downloadTracker !== undefined) {
      this._downloadTracker!.dispose();
      this._downloadTracker = undefined;
    }

    this._mainIOManager.dispose();

    this._disposed.emit();
  }

  get disposed(): ISignal<this, void> {
    return this._disposed;
  }

  async exitCode(): Promise<number> {
    return (await this._remote?.exitCode()) ?? 1;
  }

  externalInput(maxChars: number | null): Promise<string> {
    return this._externalCommands.externalInput(maxChars);
  }

  protected initRemoteOptions(options: IShell.IOptions): IShellWorker.IOptions {
    // Types of buffered IO supported.
    const sharedArrayBuffer = this._mainIOManager.sharedArrayBuffer;
    const supportsServiceWorker = this._mainIOManager.supportsServiceWorker;

    const externalCommandConfigs = options.externalCommands?.map(x => {
      return { name: x.name, hasTabComplete: x.tabComplete !== undefined };
    });

    const { baseUrl, browsingContextId, color, cwd, mountpoint, wasmBaseUrl } = options;
    const { aliases, environment, initialDirectories, initialFiles } = options;
    const { workerType } = this;

    return {
      shellId: this.shellId,
      color: color ?? true,
      mountpoint,
      cwd,
      baseUrl,
      wasmBaseUrl,
      browsingContextId,
      aliases: aliases ?? {},
      environment: environment ?? {},
      externalCommandConfigs: externalCommandConfigs ?? [],
      workerType,
      sharedArrayBuffer,
      supportsServiceWorker,
      initialDirectories,
      initialFiles
    };
  }

  /**
   * Load the web worker.
   */
  protected abstract initWorker(options: IShell.IOptions): Worker;

  async input(char: string): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const mainIO = this._mainIOManager.current;
    if (mainIO?.enabled) {
      await mainIO.push(char);
    } else {
      await this._remote!.input(char);
    }
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * A promise that is fulfilled when the terminal is ready to be started.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * Set shell size.  Overloaded to take an `ISize` object or `rows` and `columns`.
   * The former is the recommended approach, the latter was the original implementation and should
   * be considered deprecated for eventual removal.
   */
  async setSize(size: ISize): Promise<void>;
  async setSize(rows: number, columns: number): Promise<void>;
  async setSize(sizeOrRows: ISize | number, columns?: number): Promise<void> {
    if (typeof sizeOrRows === 'object') {
      await this._setSizeImpl(sizeOrRows.rows, sizeOrRows.columns);
    } else if (columns === undefined) {
      const errMsg = 'Incorrect arguments passed to IShell.setSize';
      console.error(errMsg);
      throw new Error(errMsg);
    } else {
      await this._setSizeImpl(sizeOrRows, columns);
    }
  }

  get shellId(): string {
    return this._shellId;
  }

  get size(): ISize {
    return this._size;
  }

  async start(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    await this.ready;
    await this._remote!.start();
  }

  async themeChange(isDark?: boolean): Promise<void> {
    await this._remote?.themeChange(isDark);
  }

  // This will be called just once per Shell as the result is stored.
  // Can be overridden in derived classes to support different conditions.
  protected useCoincidentWorker(): boolean {
    return crossOriginIsolated;
  }

  get workerType(): WorkerType {
    if (this._workerType === undefined) {
      this._workerType = this.useCoincidentWorker() ? 'coincident' : 'comlink';
    }
    return this._workerType;
  }

  private _commandStateChangedCallback(args: IShell.ICommandStateChangedArgs): void {
    this._commandStateChanged.emit(args);
  }

  private _downloadWasmModuleCallback(
    packageName: string,
    moduleName: string,
    start: boolean
  ): void {
    if (start) {
      if (this._downloadTracker !== undefined) {
        this._downloadTracker.dispose();
      }

      this._downloadTracker = new DownloadTracker(packageName, moduleName, this._outputCallback);
      this._downloadTracker.start();
    } else {
      if (
        this._downloadTracker !== undefined &&
        packageName === this._downloadTracker.packageName &&
        moduleName === this._downloadTracker.moduleName
      ) {
        this._downloadTracker.stop();
      }
    }
  }

  private async _enableBufferedStdinCallback(enable: boolean): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    await this._mainIOManager.setBufferedStdin(enable);
  }

  private async _initialize(options: IShell.IOptions): Promise<void> {
    const hasMainIO = await this._mainIOManager.initialize(options, this._shellId);
    if (!hasMainIO) {
      let msg = 'ERROR: Terminal needs either SharedArrayBuffer or ServiceWorker available.';
      console.error(msg);
      if (options.color ?? true) {
        msg = ansi.styleBoldRed + msg + ansi.styleReset;
      }
      options.outputCallback(msg);
      this.dispose();
      return;
    }

    // Register external commands here, the names are passed through to the WebWorker.
    this._externalCommands.register(options.externalCommands ?? []);

    if (this.workerType === 'coincident') {
      const { Worker: patchedWorker } = coincident();
      const originalWorker = globalThis.Worker;
      globalThis.Worker = patchedWorker;
      this._worker = this.initWorker(options);
      globalThis.Worker = originalWorker;
    } else {
      this._worker = this.initWorker(options);
    }

    this._initRemote(options).then(this._ready.resolve.bind(this._ready));
  }

  private async _initRemote(options: IShell.IOptions) {
    if (this._worker === undefined) {
      throw new Error('Worker does not exist');
    }

    const rrr = this.createRemote({ ...options, worker: this._worker });

    this._remote = rrr;

    const remoteOptions = this.initRemoteOptions(options);
    await this._remote.initialize(remoteOptions);

    // Register sendStdinNow callback only after this._remote has been initialized.
    this._mainIOManager.registerSendStdinNow(this._remote.input);
  }

  private async _setSizeImpl(rows: number, columns: number): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    this._size.rows = Math.max(0, rows);
    this._size.columns = Math.max(0, columns);

    await this._remote!.setSize(this._size);
  }

  private _disposed = new Signal<this, void>(this);
  private _isDisposed = false;
  private _ready = new PromiseDelegate<void>();

  private _shellId: string; // Unique identifier within a single browser tab.
  private _size: ISize = { rows: 0, columns: 0 };
  private _workerType?: WorkerType;
  private _worker?: Worker;
  private _remote?: ICoincidentShellWorker | IComlinkShellWorker;
  private _externalCommands = new ExternalCommands({
    shellId: () => this._shellId,
    size: () => this.size,
    remote: () => this._remote
  });
  private _mainIOManager = new MainIOManager();

  private _commandStateChanged = new Signal<this, IShell.ICommandStateChangedArgs>(this);
  private _downloadTracker?: DownloadTracker;
  private _outputCallback: IOutputCallback; // Only used by _downloadTracker.
}
