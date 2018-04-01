import {spawn} from 'child_process';
import { Readable, Writable } from 'stream';
import { DebugSession, LaunchOptions } from './session';

export interface LaunchOptionsSsh extends LaunchOptions {
	execSsh?: string;
	execSshArgs?: string[];
	execSshUser?: string;
	execSshAddr?: string;
	execSshEnv?: {},

}

export class SshSession implements DebugSession {
	public stdin: Writable;
	public stdout: Readable;
	public stderr: Readable;
	public on: Function;
	public kill: Function;
	public title: Function;
	public dump: Function;

	constructor(filename: string, cwd: string, args: string[] = [], options: LaunchOptionsSsh = {}) {
		const perlCommand = options.exec || 'perl';
		const programArguments = options.args || [];
		var   sshCommand  = options.execSsh ;
		const sshArgs     = options.execSshArgs || [] ;
		const sshUser     = options.execSshUser ;
		const sshAddr     = options.execSshAddr ;

		if (!sshAddr)
			throw ('missing ssh addr') ;

		var envStr = '' ;
		for (var element in options.execSshEnv) {
			envStr += ' ' + element+ "='" + options.execSshEnv[element] + "'"	;
		}
		var argsStr = '' ;
		for (var element in programArguments) {
			argsStr += " '" + element + "'"	;
		}
		if (!sshCommand)
			if (/^win/.test(process.platform))
				sshCommand = 'plink' ;
			else
				sshCommand = 'ssh' ;

		const remoteCmd   = "cd '" + cwd + "'; COLUMNS=255 LINES=25 " + envStr + ' ' + perlCommand + " -d '" + filename + "' " + argsStr ;
		const commandArgs = [].concat(sshArgs, ['-l', sshUser, sshAddr, remoteCmd]);

		const spawnOptions = {
			detached: true,
		};

		const session = spawn(sshCommand, commandArgs, spawnOptions);
		this.stdin = session.stdin;
		this.stdout = session.stdout;
		this.stderr = session.stderr;
		this.on = (type, callback) => session.on(type, callback);
		this.kill = () => session.kill();
		this.title = () => `${sshCommand} ${commandArgs.join(' ')}`;
		this.dump = () => `spawn(${sshCommand}, ${JSON.stringify(commandArgs)}, ${JSON.stringify(spawnOptions)});`;
	}
}