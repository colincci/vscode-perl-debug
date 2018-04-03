/// <reference types="node" />

import {
	Logger, logger,
	DebugSession, LoggingDebugSession,
	InitializedEvent, TerminatedEvent, ContinuedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Event,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, Variable
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import {readFileSync} from 'fs';
import {basename, dirname, join} from 'path';
import {spawn, ChildProcess} from 'child_process';
const { Subject } = require('await-notify');
import { perlDebuggerConnection } from './adapter';
import { variableType, ParsedVariable, ParsedVariableScope, resolveVariable } from './variableParser';

/**
 * This interface should always match the schema found in the perl-debug extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** Perl binary */
	exec: string;
	/** Binary executable arguments */
	execArgs: string[],
	/** ssh binary */
	sshCmd: string;
	/** ssh binary executable arguments */
	sshArgs: string[],
	/** ssh user */
	sshUser: string;
	/** ssh remote ip addr */
	sshAddr: string,
	/** Workspace path */
	root: string,
	/** Root of client, network prefix e.g. \\1.2.3.4\share */
	clientRoot: string,
	/** An absolute path (on client) to the program to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** List of includes */
	inc?: string[];
	/** List of program arguments */
	args?: string[];
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** env variables when executing debugger */
	env?: {};
	/** port for debugger to listen for remote debuggers */
	port?,
}

class PerlDebugSession extends LoggingDebugSession {
	private static THREAD_ID = 1;

	private _breakpointId = 1000;

	// This is the next line that will be 'executed'
	private __currentLine = 0;
	private get _currentLine() : number {
		return this.__currentLine;
    }
	private set _currentLine(line: number) {
		this.__currentLine = line;
	}

	private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();
	private _functionBreakPoints: string[] = [];

	private _variableHandles = new Handles<string>();
	private _stackFrames: StackFrame[] = [];

	private perlDebugger = new perlDebuggerConnection();

	private _isRunning: boolean = false ;

	public constructor() {
		super('perl_debugger.log');

		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
	}

	private rootPath: string = '';

	private _configurationDone = new Subject();

   /* protected convertClientPathToDebugger(clientPath: string): string {
		return clientPath.replace(this.rootPath, '');
	}

    protected convertDebuggerPathToClient(debuggerPath: string): string {
		return join(this.rootPath, debuggerPath);
	}*/

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// Rig output
		this.perlDebugger.onOutput = (text) => {
			this.sendEvent(new OutputEvent(`${text}\n`));
		};

		this.perlDebugger.onException = (res) => {
			// xxx: for now I need more info, code to go away...
			const [ error ] = res.errors;
			this.sendEvent(new OutputEvent(`onException: ${error && error.near}`));
		};

		this.perlDebugger.onTermination = (res) => {
			this.sendEvent(new TerminatedEvent());
		};

		this.perlDebugger.onContinued = (res) => {
			this.sendEvent(new ContinuedEvent(PerlDebugSession.THREAD_ID));
		};

		this.perlDebugger.onClose = (code) => {
			this.sendEvent(new TerminatedEvent());
		};

		this.perlDebugger.initializeRequest()
			.then(() => {
				// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
				// we request them early by sending an 'initializeRequest' to the frontend.
				// The frontend will end the configuration sequence by calling 'configurationDone' request.
				this.sendEvent(new InitializedEvent());

				// This debug adapter implements the configurationDoneRequest.
				response.body.supportsConfigurationDoneRequest = true;

				// make VS Code to use 'evaluate' when hovering over source
				response.body.supportsEvaluateForHovers = true;

				// make VS Code to show a 'step back' button
				response.body.supportsStepBack = false;

				// The debug adapter supports setting a variable to a value.
				response.body.supportsSetVariable = true ;

				response.body.supportsFunctionBreakpoints = false;

				this.sendResponse(response);
			});
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {

		this.perlDebugger.destroy()
			.then(() => {
				this.sendResponse(response);
			})
			.catch((err) => {
				const [ error = err ] = err.errors || [];
				this.sendEvent(new OutputEvent(`ERR>cannot destroy debugger error: ${error.message}\n`));
				this.sendResponse(response);
			}) ;
		}


	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		this.rootPath = args.root;

		const inc = args.inc && args.inc.length ? args.inc.map(directory => `-I${directory}`) : [];
		const execArgs = [].concat(args.execArgs || [], inc);
		const programArguments = args.args || [];

		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		await this._configurationDone.wait(1000);
		this.perlDebugger.launchRequest(args.program, args.root, args.clientRoot, execArgs, {
			exec: args.exec,
			args: programArguments,
			env: {
				PATH: process.env.PATH || '',
				// PERL5OPT: process.env.PERL5OPT || '',
				PERL5LIB: process.env.PERL5LIB || '',
				...args.env
			},
			port: args.port || undefined,
			execSsh:    args.sshCmd,
			execSshArgs: args.sshArgs,
			execSshUser: args.sshUser,
			execSshAddr: args.sshAddr,
			execSshEnv:  args.env,
		})
			.then((res) => {
				if (args.stopOnEntry) {
					if (res.ln) {
						this._currentLine = res.ln - 1;
					}
					this.sendResponse(response);

					// we stop on the first line
					this.sendEvent(new StoppedEvent("entry", PerlDebugSession.THREAD_ID));
				} else {
					// we just start to run until we hit a breakpoint or an exception
					this.continueRequest(<DebugProtocol.ContinueResponse>response, { threadId: PerlDebugSession.THREAD_ID });
				}
			});

	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// xxx: Not sure if this is sufficient to levarage multi cores?
		// return the default thread
		response.body = {
			threads: [
				new Thread(PerlDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}


/**
 * TODO
 *
 * if possible:
 *
 * * step out
 * * step back
 * * reverse continue
 */


	/**
	 * Reverse continue
	 */
	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) : void {
		this.sendEvent(new OutputEvent(`ERR>Reverse continue not implemented\n\n`));

		this.sendResponse(response);
		// no more lines: stop at first line
		this._currentLine = 0;
		this.sendEvent(new StoppedEvent("entry", PerlDebugSession.THREAD_ID));
 	}

	/**
	 * Step back
	 */
	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this.sendEvent(new OutputEvent(`ERR>Step back not implemented\n`));

		this.sendResponse(response);
		// no more lines: stop at first line
		this._currentLine = 0;
		this.sendEvent(new StoppedEvent("entry", PerlDebugSession.THREAD_ID));
	}





	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		//this.sendEvent(new OutputEvent(`ERR>pause not implemented\n`));
		this.perlDebugger.pause() ;
		this.sendResponse(response);
		//this.sendEvent(new StoppedEvent("breakpoint", PerlDebugSession.THREAD_ID));
	}



	private async setFunctionBreakPointsRequestAsync(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): Promise<DebugProtocol.SetFunctionBreakpointsResponse> {
		const breakpoints: string[] = [];
		const newBreakpoints: string[] = args.breakpoints.map(bp => { return bp.name });
		const neoBreakpoints: DebugProtocol.FunctionBreakpoint[] = [];

		for (var i = 0; i < this._functionBreakPoints.length; i++) {
			const name = this._functionBreakPoints[i];
			if (newBreakpoints.indexOf(name) < 0) {
				this.sendEvent(new OutputEvent(`Remove ${name}\n`));
				await this.perlDebugger.request(`B ${name}`);
			}
		}

		for (var i = 0; i < args.breakpoints.length; i++) {
			const bp = args.breakpoints[i];
			if (this._functionBreakPoints.indexOf(bp.name) < 0) {
				breakpoints.push(bp.name);
				const res = await this.perlDebugger.request(`b ${bp.name}`);

				this.sendEvent(new OutputEvent(`Add ${bp.name}\n`));
				const neoBreakpoint = <DebugProtocol.FunctionBreakpoint>{name: bp.name};
				neoBreakpoints.push(neoBreakpoint);
				response.body.breakpoints = [new Breakpoint(true, 4, 0, new Source('Module.pm', join(/* this.filepath, */ 'Module.pm')) )];
				this.sendResponse(response);

				this.sendEvent(new OutputEvent(`Add ${bp.name}\n`));
			} else {
				neoBreakpoints.push(bp);
			}
		}

		this._functionBreakPoints = breakpoints;

		return response;
	}

	protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): void {
		this.setFunctionBreakPointsRequestAsync(response, args)
			.then(res => {
				this.sendResponse(response);
			})
			.catch(err => {
				const [ error = err ] = err.errors || [];
				this.sendEvent(new OutputEvent(`ERR>setFunctionBreakPointsRequest error: ${error.message}\n`));
				this.sendResponse(response);
			});
	}

/**
 * Implemented
 */

	/**
	 * Set variable
	 */
    protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		// Get type of variable contents
		const name = this.getVariableName(args.name, args.variablesReference)
			.then((variableName) => {

				return this.perlDebugger.request(`${variableName}='${args.value}'`)
					.then(() => {
						response.body = {
							value: args.value,
							type: variableType(args.value),
						};
						this.sendResponse(response);
					});
			})
			.catch((err) => {
				const [ error = err ] = err.errors || [];
				this.sendEvent(new OutputEvent(`ERR>setVariableRequest error: ${error.message}\n`));
				this.sendResponse(response);
			});
	}

	/**
	 * Step out
	 */
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.perlDebugger.request('r')
			.then((res) => {
				if (res.ln) {
					this._currentLine = this.convertDebuggerLineToClient(res.ln);
				}

				this.sendResponse(response);

				if (res.finished) {
					this.sendEvent(new TerminatedEvent());
				} else {
					this.sendEvent(new StoppedEvent("step", PerlDebugSession.THREAD_ID));
				}
				// no more lines: run to end
			})
			.catch(err => {
				const [ error = err ] = err.errors || [];
				if (err.exception) {
					this.sendEvent(new StoppedEvent("exception", PerlDebugSession.THREAD_ID, error.near));
				} else {
					this.sendEvent(new OutputEvent(`ERR>StepOut error: ${error.message}\n`));
					this.sendEvent(new TerminatedEvent());
				}
				this.sendResponse(response);
			});
	}

	/**
	 * Step in
	 */
    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.perlDebugger.request('s')
			.then((res) => {
				if (res.ln) {
					this._currentLine = this.convertDebuggerLineToClient(res.ln);
				}

				this.sendResponse(response);

				if (res.finished) {
					this.sendEvent(new TerminatedEvent());
				} else {
					this.sendEvent(new StoppedEvent("step", PerlDebugSession.THREAD_ID));
				}
				// no more lines: run to end
			})
			.catch(err => {
				const [ error = err ] = err.errors || [];
				if (err.exception) {
					this.sendEvent(new StoppedEvent("exception", PerlDebugSession.THREAD_ID, error.near));
				} else {
					this.sendEvent(new OutputEvent(`ERR>StepIn error: ${error.message}\n`));
					this.sendEvent(new TerminatedEvent());
				}
				this.sendResponse(response);
			});
	}

	/**
	 * Restart
	 */
	private async restartRequestAsync(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): Promise<DebugProtocol.RestartResponse> {
		const res = await this.perlDebugger.request('R')
		if (res.ln) {
			this._currentLine = this.convertDebuggerLineToClient(res.ln);
		}
		if (res.finished) {
			this.sendEvent(new TerminatedEvent());
		} else {
			this.sendEvent(new StoppedEvent("entry", PerlDebugSession.THREAD_ID));
		}

		return response;
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): void {
		this.restartRequestAsync(response, args)
			.then(res => this.sendResponse(res))
			.catch(err => this.sendResponse(response));
	}

	/**
	 * Breakpoints
	 */
	private async setBreakPointsRequestAsync(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<DebugProtocol.SetBreakpointsResponse> {

		var path = this.perlDebugger.serverPath(args.source.path);
		var clientLines = args.lines;

		const debugPath = await this.perlDebugger.clientPath(path);
		const editorExisting = this._breakPoints.get(path);
		const editorBPs: number[] = args.lines.map(ln => ln);
		const dbp = await this.perlDebugger.getBreakPoints();
		const debuggerPBs: number[] = (await this.perlDebugger.getBreakPoints())[debugPath] || [];
		const createBP: number[] = [];
		const removeBP: number[] = [];
		var breakpoints = new Array<Breakpoint>();
		var postpone = false ;

		// Clean up debugger removing unset bps
		for (let i = 0; i < debuggerPBs.length; i++) {
		 	const ln = debuggerPBs[i];
			if (editorBPs.indexOf(ln) < 0) {
				await this.perlDebugger.clearBreakPoint(ln, debugPath);
			}
		}

		// Add missing bps to the debugger
		for (let i = 0; i < editorBPs.length; i++) {
		 	const ln = editorBPs[i];
			if (debuggerPBs.indexOf(ln) < 0) {
				try {
					const res = await this.perlDebugger.setBreakPoint(ln, debugPath);
					const bp = <DebugProtocol.Breakpoint> new Breakpoint(true, ln);
					bp.id = this._breakpointId++;
					breakpoints.push(bp);
				} catch(err) {
					const bp = <DebugProtocol.Breakpoint> new Breakpoint(false, ln);
					bp.id = this._breakpointId++;
					breakpoints.push(bp);
					postpone = true ;
				}
			} else {
				// This is good
				const bp = <DebugProtocol.Breakpoint> new Breakpoint(true, ln);
				bp.id = this._breakpointId++;
				breakpoints.push(bp);
			}
		}

		this._breakPoints.set(path, breakpoints);

		if (postpone) {
			await this.perlDebugger.setLoadBreakPoint (debugPath) ;
		}

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: breakpoints
		};

		return response;
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		var wasRunning = false ;
		if (this._isRunning) {
			this.perlDebugger.pause() ;
			wasRunning = true ;
		}

		this.setBreakPointsRequestAsync(response, args)
			.then(res => {
				this.sendResponse(res)
				if (wasRunning) {
					this.continueRequest(null, null) ;
				}
			})
			.catch(err => this.sendResponse(response));

	}

	protected async setBreakPointsForFile(path: string): Promise<number> {
		const debugPath = await this.perlDebugger.clientPath(path);
		const editorExisting = this._breakPoints.get(path) || [] ;
		const debuggerPBs: number[] = (await this.perlDebugger.getBreakPoints())[debugPath] || [];
		var breakpoints = new Array<Breakpoint>();

		// Add missing bps to the debugger
		for (let i = 0; i < editorExisting.length; i++) {
		 	var bp: DebugProtocol.Breakpoint = editorExisting[i];
			if (debuggerPBs.indexOf(bp.line) < 0) {
				try {
					const res = await this.perlDebugger.setBreakPoint(bp.line, debugPath);
					bp.verified = true;
					breakpoints.push(bp);
					this.sendEvent(new BreakpointEvent('changed', bp));
				} catch(err) {
					bp.verified = false;
					breakpoints.push(bp);
				}
			} else {
				// This is good
				breakpoints.push(bp);
			}
		}

		this._breakPoints.set(path, breakpoints);

		return 0 ;
	}



	/**
	 * Next
	 */
	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.perlDebugger.request('n')
			.then((res) => {
				if (res.ln) {
					this._currentLine = this.convertDebuggerLineToClient(res.ln);
				}

				this.sendResponse(response);

				if (res.finished) {
					this.sendEvent(new TerminatedEvent());
				} else {
					this.sendEvent(new StoppedEvent("step", PerlDebugSession.THREAD_ID));
				}
				// no more lines: run to end
			})
			.catch(err => {
				const [ error = err ] = err.errors || [];
				if (err.exception) {
					this.sendEvent(new StoppedEvent("exception", PerlDebugSession.THREAD_ID, error.near));
				} else {
					this.sendEvent(new OutputEvent(`ERR>Next error: ${error.message}\n`));
					this.sendEvent(new TerminatedEvent());
				}
				this.sendResponse(response);
			});
	}


	/**
	 * Continue
	 */
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.sendEvent(new ContinuedEvent(PerlDebugSession.THREAD_ID));
		this._isRunning = true ;
		this.perlDebugger.request('c')
			.then((res) => {
				this._isRunning = false ;
				var loaded: string[] ;
				if (res.ln) {
					this._currentLine = this.convertDebuggerLineToClient(res.ln);
				}
				if (response)
					this.sendResponse(response);

				if (res.finished) {
					this.sendEvent(new TerminatedEvent());
				} else if (loaded = res.data[0].match (/'(.+?)' loaded/)) {
					const path = this.perlDebugger.serverPath(loaded[1]);
					this.setBreakPointsForFile (path).then(() => {
						this.continueRequest (response, args) ;
					})
					.catch((err) => {
						this.sendEvent(new OutputEvent(`ERR>Set Breakpoint for  ${loaded[0]}\n`));
					}) ;
				} else {
					this.sendEvent(new StoppedEvent("breakpoint", PerlDebugSession.THREAD_ID));
				}
			})
			.catch((err) => {
				this._isRunning = false ;
				const [ error = err ] = err.errors || [];
				if (err.exception) {
					this.sendEvent(new StoppedEvent("exception", PerlDebugSession.THREAD_ID, error.near));
				} else {
					this.sendEvent(new OutputEvent(`ERR>Continue error: ${error.message}\n`));
					this.sendEvent(new TerminatedEvent());
				}
				if (response)
					this.sendResponse(response);
			});
	}

	/**
	 * Scope request
	 */
	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Local", this._variableHandles.create("#" + frameReference), false));
		if (this._stackFrames.length > frameReference) {
			var frameName = this._stackFrames[frameReference].name ;
			var n ;
			if ((n = frameName.match(/^.+?\(/)))
				frameName = n[0] ;
			const pkg = frameName.replace(/::[^:]*$/,'') ;
			if (pkg) {
				scopes.push(new Scope("Global", this._variableHandles.create("=" + pkg), true));
				scopes.push(new Scope("Special", this._variableHandles.create("-" + pkg), true));
			}
		}

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	private getVariableName(name: string, variablesReference: number): Promise<string> {
		let id = this._variableHandles.get(variablesReference);

		const type = id.substr(0,1) ;
		const arg  = id.substr(1) ;
		const scopes = {} ;
		scopes[id] = arg ;

		return this.perlDebugger.variableList(scopes)
		.then(variables => {
			return resolveVariable(name, id, variables);
		});
	}

	/**
	 * Variable scope
	 */
	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		const id = this._variableHandles.get(args.variablesReference);

		const type = id.substr(0,1) ;
		const arg  = id.substr(1) ;
		const scopes = {} ;
		scopes[id] = arg ;

		this.perlDebugger.variableList(scopes)
					.then(variables => {
				const result = [];

				if (id != null && variables[id]) {
					const len = variables[id].length;
					const result = variables[id].map(variable => {
						// Convert the parsed variablesReference into Variable complient references
						if (variable.variablesReference === '0') {
							variable.variablesReference = 0;
						} else if (!isNaN(Number(variable.variablesReference))) {
							variable.variablesReference = Number(variable.variablesReference) ;
						} else {
							variable.variablesReference = this._variableHandles.create(`${variable.variablesReference}`);
						}
						return variable;
					});

					response.body = {
						variables: <Variable[]>result.sort ((a,b) => { if (a.name > b.name) { return 1 } if (a.name < b.name) { return -1 } return 0 })
					};
					this.sendResponse(response);
				} else {
					this.sendResponse(response);
				}
			})
			.catch(() => {
				this.sendResponse(response);
			});
	}


	/**
	 * Evaluate command line
	 */
	private evaluateCommandLine(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
		this.perlDebugger.request(args.expression)
			.then((res) => {
				if (res.data.length > 1) {
					res.data.forEach((line) => {
						this.sendEvent(new OutputEvent(`> ${line}\n`));
					});
					response.body = {
						result: `Result:`,
						variablesReference: 0,
					};
				} else {
					response.body = {
						result: `${res.data[0]}`,
						variablesReference: 0
					};
				}
				this.sendResponse(response);
			});
	};

	/**
	 * Fetch expression value
	 */
	async fetchExpressionRequest(clientExpression, level): Promise<any> {

		const isVariable = /^([\$|@|%])([a-zA-Z0-9_\'\.]+)$/.test(clientExpression);

		const expression = isVariable ? clientExpression.replace(/\.(\'\w+\'|\w+)/g, (...a) => `->{${a[1]}}`) : clientExpression;

		let value = await this.perlDebugger.getExpressionValue(expression, level);
		if (/^Can\'t use an undefined value as a HASH reference/.test(value)) {
			value = undefined;
		}
		if (/^(?:HASH|ARRAY)/.test(value)) {
			return {
				value: value,
				reference: this._variableHandles.create(`${value}`),
			};
		}
		return {
			value: value,
			reference: null,
		};
	}

	/**
	 * Evaluate watch/hover
	 * Note: We don't actually levarage the debugger watch capabilities yet
	 */
	protected evaluateVariable(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		// Clear watch if last request wasn't setting a watch?
		let level = args.frameId + 1 ;
		this.fetchExpressionRequest(args.expression, level)
			.then(result => {
				let ref : number ;
				if (typeof result.value !== 'undefined') {
					if (result.reference == 0) {
						ref = 0;
					} else if (!isNaN(Number(result.reference))) {
						ref = Number(result.reference) ;
					} else {
						ref = this._variableHandles.create(result.reference);
					}
				response.body = {
						result: result.value,
						variablesReference: ref,
					};
				}
				this.sendResponse(response);
			})
			.catch(() => {});
	}

	/**
	 * Evaluate
	 */
	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		if (args.context === 'repl') {
			this.evaluateCommandLine(response, args);
		} else if (args.context === 'hover') {
			this.evaluateVariable(response, args);
		} else if (args.context === 'watch') {
			this.evaluateVariable(response, args);
		} else {
			this.sendEvent(new OutputEvent(`evaluate(context: '${args.context}', '${args.expression}')`));
			response.body = {
				result: `evaluate(context: '${args.context}', '${args.expression}')`,
				variablesReference: 0
			};
			this.sendResponse(response);
		}
	}

	/**
	 * Stacktrace
	 */
	private async stackTraceRequestAsync(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<DebugProtocol.StackTraceResponse> {
		const stacktrace = await this.perlDebugger.getStackTrace();
		const frames = new Array<StackFrame>();

		// In case this is a trace run on end, we want to return the file with the exception in the @ position
		let endFrame = null;

		stacktrace.forEach((trace, i) => {
			const frame = new StackFrame(i, `${trace.caller}`, new Source(basename(trace.filename),
				this.convertDebuggerPathToClient(trace.filename)),
				trace.ln, 0);
			frames.push(frame);
			if (trace.caller === 'DB::END()') {
				endFrame = frame;
			}
		});

		if (endFrame) frames.unshift(endFrame);
		this._stackFrames = frames;

		response.body = {
			stackFrames: frames,
			totalFrames: frames.length
		};

		return response;
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this.stackTraceRequestAsync(response, args)
			.then(res => this.sendResponse(res))
			.catch(err => {
				const [ error = err ] = err.errors || [];
				this.sendEvent(new OutputEvent(`--->Trace error...${error.message}\n`));
				response.body = {
					stackFrames: [],
					totalFrames: 0
				};
				this.sendResponse(response);
			});
	}
}

DebugSession.run(PerlDebugSession);
