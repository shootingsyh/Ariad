import { AriadV2Service as PollingAriadV2Service } from './ariad-v2-service-legacy.js';
import { ReconcileTrigger } from '../../../src/v2/reconcile-trigger.js';
import { SQLiteReconcileSignal } from '../../../src/v2/sqlite-reconcile-signal.js';

type ServiceArgs = ConstructorParameters<typeof PollingAriadV2Service>[0];

/**
 * Event-driven facade for the V2 service.
 *
 * The legacy implementation remains responsible for one deterministic
 * reconcile pass. This facade deliberately does not call legacy start(), so
 * its 250ms polling timer is never created. Durable SQLite mutations advance
 * per-project generations; API mutations wake this single-flight trigger.
 */
export class AriadV2Service extends PollingAriadV2Service {
  private readonly eventManager: ServiceArgs['manager'];
  private readonly signals = new Map<string, SQLiteReconcileSignal>();
  private readonly trigger: ReconcileTrigger;

  constructor(args: ServiceArgs) {
    super(args);
    this.eventManager = args.manager;
    this.trigger = new ReconcileTrigger({
      reconcile: () => super.reconcile(),
      readGeneration: () => this.readGeneration(),
      safetyIntervalMs: 10 * 60 * 1000,
      onError: (error: unknown) => args.logger?.error?.(
        `Ariad event-driven reconcile failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
      ),
    });
  }

  private signalFor(project: any) {
    if (!project?.stateDb) return null;
    let signal = this.signals.get(project.id);
    if (!signal) {
      signal = new SQLiteReconcileSignal(project.stateDb);
      this.signals.set(project.id, signal);
    }
    return signal;
  }

  private readGeneration() {
    let generation = 0;
    for (const project of this.eventManager.list()) {
      generation += this.signalFor(project)?.read() ?? 0;
    }
    return generation;
  }

  private wake(reason: string) {
    this.trigger.wake(reason);
  }

  override async start() {
    // Preserve startup recovery semantics synchronously, then become purely
    // event driven. start() on the legacy service is intentionally not used.
    await super.reconcile();
    this.trigger.start();
  }

  override async stop() {
    this.trigger.stop();
    for (const signal of this.signals.values()) signal.close();
    this.signals.clear();
    await super.stop();
  }

  override async iterate(name: string, request: string) {
    const result = await super.iterate(name, request);
    this.wake('iterate');
    return result;
  }

  override async ensureRunning(name: string) {
    const result = await super.ensureRunning(name);
    this.wake('running');
    return result;
  }

  override async ensurePaused(name: string) {
    const result = await super.ensurePaused(name);
    this.wake('paused');
    return result;
  }

  override async ensureResumed(name: string) {
    const result = await super.ensureResumed(name);
    this.wake('resumed');
    return result;
  }

  override async ensureStopped(name: string) {
    const result = await super.ensureStopped(name);
    this.wake('stopped');
    return result;
  }

  override submitRoleResultByAttempt(attemptId: string, role: string, payload: any) {
    const result = super.submitRoleResultByAttempt(attemptId, role, payload);
    this.wake('role-result');
    return result;
  }

  override submitRoleResult(binding: any, payload: any) {
    const result = super.submitRoleResult(binding, payload);
    this.wake('role-result');
    return result;
  }

  override async submitDecision(name: string, decision: string) {
    const result = await super.submitDecision(name, decision);
    this.wake('human-decision');
    return result;
  }
}
