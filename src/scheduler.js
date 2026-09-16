export class Scheduler {
  constructor({ resourceManager, isRuntimeHealthy, dispatch }) {
    if (!resourceManager || typeof resourceManager.tryAcquire !== 'function') throw new Error('Scheduler requires resourceManager');
    if (typeof isRuntimeHealthy !== 'function') throw new Error('Scheduler requires isRuntimeHealthy');
    if (typeof dispatch !== 'function') throw new Error('Scheduler requires dispatch');
    this.resourceManager = resourceManager;
    this.isRuntimeHealthy = isRuntimeHealthy;
    this.dispatch = dispatch;
  }

  async tryDispatch(work) {
    if (!work?.runtimeKey) throw new Error('work.runtimeKey is required');
    if (!this.isRuntimeHealthy(work.runtimeKey)) {
      return { status:'BLOCKED_RUNTIME', runtimeKey:work.runtimeKey };
    }

    const leases=[];
    try {
      for (const resource of work.resources ?? []) {
        const lease=this.resourceManager.tryAcquire(resource, work.taskId);
        if (!lease) {
          for (const held of leases.reverse()) await held.release();
          return { status:'WAITING_RESOURCE', resource };
        }
        leases.push(lease);
      }

      const result=await this.dispatch(work);
      return { status:'DISPATCHED', result };
    } finally {
      for (const lease of leases.reverse()) {
        try { await lease.release(); } catch {}
      }
    }
  }
}
