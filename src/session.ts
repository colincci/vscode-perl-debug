import { Readable, Writable }  from 'stream';

export interface DebugSession {
	kill: Function,
	stderr: Readable,
	stdout: Readable,
	stdin: Writable,
	on: Function, // support "close", "error"
	title: Function,
	dump: Function, // Dump debug information
	interrupt: Function, // send CTRL-C (SIGINT) to perl debugger
}

export interface LaunchOptions {
	exec?: string;
	args?: string[];
	env?: {},
	port?: number;
}