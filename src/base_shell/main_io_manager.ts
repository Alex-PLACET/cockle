import type { IMainIO, IStdinReply, IStdinRequest } from '../buffered_io';
import { ServiceWorkerMainIO, SharedArrayBufferMainIO } from '../buffered_io';
import type { IOutputCallback } from '../callback';
import type { IShell } from '../defs';

/**
 * Owns the main-thread stdin IO objects (SharedArrayBuffer and service worker)
 * and tracks which one is active.
 */
export class MainIOManager {
  /**
   * Create and probe the available IO types.
   * Returns true if at least one of them can be used.
   */
  async initialize(options: IShell.IOptions, shellId: string): Promise<boolean> {
    if (window.crossOriginIsolated) {
      this._sharedArrayBufferMainIO = new SharedArrayBufferMainIO();
    }

    if (options.browsingContextId !== undefined) {
      this._serviceWorkerMainIO = new ServiceWorkerMainIO(
        options.baseUrl,
        options.browsingContextId,
        shellId
      );

      // Do not trust that service worker is functioning, test it.
      await this._serviceWorkerMainIO.enable();
      const ok = await this._serviceWorkerMainIO.testWithTimeout(1000);
      await this._serviceWorkerMainIO.disable();
      if (ok) {
        console.log('Service worker supports terminal stdin');
      } else {
        console.log('Service worker does not support terminal stdin');
        this._serviceWorkerMainIO.dispose();
        this._serviceWorkerMainIO = undefined;
      }
    }

    this._mainIO = this._sharedArrayBufferMainIO ?? this._serviceWorkerMainIO;
    return this._mainIO !== undefined;
  }

  get current(): IMainIO | undefined {
    return this._mainIO;
  }

  get sharedArrayBuffer(): SharedArrayBuffer | undefined {
    return this._sharedArrayBufferMainIO?.sharedArrayBuffer;
  }

  get supportsServiceWorker(): boolean {
    return this._serviceWorkerMainIO !== undefined;
  }

  // Register sendStdinNow callback only after the remote has been initialized.
  registerSendStdinNow(sendStdinNow: IOutputCallback): void {
    this._sharedArrayBufferMainIO?.registerSendStdinNow(sendStdinNow);
    this._serviceWorkerMainIO?.registerSendStdinNow(sendStdinNow);
  }

  async handleServiceWorkerStdin(request: IStdinRequest): Promise<IStdinReply> {
    if (this._serviceWorkerMainIO !== undefined) {
      return await this._serviceWorkerMainIO.handleStdin(request);
    } else {
      // Should never be called if _serviceWorkerMainIO does not exist.
      throw new Error('No serviceWorker handleStdin exists');
    }
  }

  async setBufferedStdin(enable: boolean): Promise<void> {
    if (enable) {
      await this._mainIO?.enable();
    } else {
      await this._mainIO?.disable();
    }
  }

  setMainIO(shortName: string): void {
    const oldMainIO = this._mainIO;

    if (shortName === 'sab' && this._sharedArrayBufferMainIO !== undefined) {
      this._mainIO = this._sharedArrayBufferMainIO;
    } else if (shortName === 'sw' && this._serviceWorkerMainIO !== undefined) {
      this._mainIO = this._serviceWorkerMainIO;
    } else {
      throw new Error(`Cannot set MainIO to '${shortName}'`);
    }

    // Disable old worker IO before switching it. This is a no-op if already disabled.
    oldMainIO?.disable();
  }

  dispose(): void {
    this._sharedArrayBufferMainIO?.dispose();
    this._sharedArrayBufferMainIO = undefined;
    this._serviceWorkerMainIO?.dispose();
    this._serviceWorkerMainIO = undefined;
    this._mainIO = undefined;
  }

  private _serviceWorkerMainIO?: ServiceWorkerMainIO;
  private _sharedArrayBufferMainIO?: SharedArrayBufferMainIO;
  private _mainIO?: IMainIO;
}
