import { PromiseDelegate } from '@lumino/coreutils';
import type { ISize } from '../callback';
import type { ICoincidentShellWorker } from '../coincident_shell_worker';
import type { IComlinkShellWorker } from '../comlink_shell_worker';
import type { IExternalRunContext } from '../context';
import { ExitCode } from '../exit_code';
import type { IExternalCommand, IExternalTabCompleteResult } from '../external_command';
import { ExternalEnvironment } from '../external_environment';
import { ExternalTermios } from '../external_termios';
import { ExternalInput, ExternalOutput } from '../io';
import type { Termios } from '../termios';

type IRemote = ICoincidentShellWorker | IComlinkShellWorker;

export interface IExternalCommandsHost {
  shellId: () => string;
  size: () => ISize;
  remote: () => IRemote | undefined;
}

/**
 * Registry of external commands, which run in the browser UI thread, and the calls
 * between the main thread and the web worker that use them.
 */
export class ExternalCommands {
  constructor(private readonly _host: IExternalCommandsHost) {}

  register(commands: IExternalCommand.IOptions[]): void {
    commands.forEach(cmd => this._commands.set(cmd.name, cmd));
  }

  /**
   * Call an external command, i.e. one that runs in the browser UI thread.
   */
  callExternalCommand(
    name: string,
    args: string[],
    environment: Record<string, string>,
    stdinIsTerminal: boolean,
    stdoutIsTerminal: boolean,
    stderrIsTerminal: boolean,
    termiosFlags: Termios.IFlags
  ): void {
    const remote = this._host.remote()!;
    const commandOptions = this._commands.get(name);
    if (commandOptions === undefined) {
      // This should not happen unless the command has not been registered properly.
      remote.exitExternalCommand({ exitCode: ExitCode.CANNOT_FIND_COMMAND });
      return;
    }

    const { command } = commandOptions;
    const externalEnvironment = new ExternalEnvironment(Object.entries(environment));
    const stdin = new ExternalInput(this.externalInput.bind(this), stdinIsTerminal);
    const stdout = new ExternalOutput(text => remote.externalOutput(text, false), stdoutIsTerminal);
    const stderr = new ExternalOutput(text => remote.externalOutput(text, true), stderrIsTerminal);
    const termios = new ExternalTermios(termiosFlags, remote.externalSetTermios);

    const context: IExternalRunContext = {
      name,
      args,
      environment: externalEnvironment,
      shellId: this._host.shellId(),
      stdin,
      stdout,
      stderr,
      size: () => this._host.size(),
      termios
    };
    command(context).then(exitCode => {
      // Exit code is returned via a separate message to the web worker rather than a return from this
      // function.
      const environmentChanges = externalEnvironment.changed;
      remote.exitExternalCommand({ exitCode, environmentChanges });
    });
  }

  /**
   * Call tab completion for an external command.
   */
  async callExternalTabComplete(name: string, args: string[]): Promise<IExternalTabCompleteResult> {
    const commandOptions = this._commands.get(name);
    if (commandOptions === undefined) {
      // This should not happen unless the command has not been registered properly.
      console.warn("'{name} is not a registered external command");
      return {};
    }

    const { tabComplete } = commandOptions;
    if (tabComplete === undefined) {
      // This should not happen unless the command has not been registered properly.
      console.warn("External command '{name} does not support tab completion");
      return {};
    }

    return await tabComplete({ name, args, shellId: this._host.shellId() });
  }

  async externalInput(maxChars: number | null): Promise<string> {
    if (this._externalStdinPromise !== undefined) {
      this._externalStdinPromise.reject('Previous external stdin request did not complete');
    }
    const promise = new PromiseDelegate<string>();
    this._externalStdinPromise = promise;

    this._host.remote()!.externalInput(maxChars);
    return await promise.promise;
  }

  // Handler for externalInputReturn callback from worker.
  handleInputReturn(text: string): void {
    if (this._externalStdinPromise !== undefined) {
      this._externalStdinPromise.resolve(text);
      this._externalStdinPromise = undefined;
    }
  }

  private _commands = new Map<string, IExternalCommand.IOptions>();
  private _externalStdinPromise?: PromiseDelegate<string>;
}
