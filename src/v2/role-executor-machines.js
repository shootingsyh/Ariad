import { defineExecutorMachine } from './executor-dsl.js';

// Role completion is driven by a signal returned from an operation, not by
// the scheduler. Each executor owns its role sequence and retry policy.
export const milestoneMachine = defineExecutorMachine({
  id: 'milestone-executor', version: 1, initial: 'DEVELOP',
  states: {
    DEVELOP: { operation: 'runDeveloper', transitions: { PASS: 'TEST_ENGINEER', RETRY: 'DEVELOP', ESCALATE: 'DEBUG' } },
    TEST_ENGINEER: { operation: 'runTestEngineer', transitions: { PASS: 'TEST', RETRY: 'DEVELOP', ESCALATE: 'DEBUG' } },
    TEST: { operation: 'runTester', transitions: { PASS: 'REVIEW', REPLAN_TESTS: 'TEST_ENGINEER', RETRY: 'DEVELOP', ESCALATE: 'DEBUG' } },
    REVIEW: { operation: 'runReviewer', transitions: { PASS: 'COMPLETE', UX_REVIEW: 'UX_REVIEW', RETRY: 'DEVELOP', ESCALATE: 'DEBUG' } },
    UX_REVIEW: { operation: 'runUxReviewer', transitions: { PASS: 'COMPLETE', RETRY: 'DEVELOP', ESCALATE: 'DEBUG' } },
    DEBUG: { operation: 'runDebugger', transitions: { REPAIRED: 'DEVELOP', ROUTE_ARTIST: 'ARTIST', ROUTE_PM: 'PM', WAIT_REPLAN: 'REPLAN_PENDING', NEEDS_HUMAN: 'FAILED' } },
    ARTIST: { operation: 'runArtist', transitions: { PASS: 'DEVELOP', ESCALATE: 'DEBUG' } },
    PM: { operation: 'runPM', transitions: { PASS: 'DEVELOP', NEEDS_HUMAN: 'FAILED' } },
    REPLAN_PENDING: {},
    COMPLETE: {}, FAILED: {},
  },
});

export const subPlanMachine = defineExecutorMachine({
  id: 'sub-plan-executor', version: 1, initial: 'PLAN',
  states: {
    PLAN: { operation: 'runTechLead', transitions: { PASS: 'VALIDATE', RETRY: 'PLAN', ESCALATE: 'DEBUG' } },
    VALIDATE: { operation: 'runPlanValidator', transitions: { PASS: 'CRITIQUE', SKIP_CRITIC: 'COMPLETE', RETRY: 'PLAN', ESCALATE: 'DEBUG' } },
    CRITIQUE: { operation: 'runCritic', transitions: { PASS: 'COMPLETE', RETRY: 'PLAN', ESCALATE: 'DEBUG' } },
    DEBUG: { operation: 'runDebugger', transitions: { REPAIRED: 'PLAN', NEEDS_HUMAN: 'FAILED' } },
    COMPLETE: {}, FAILED: {},
  },
});

export const adhocMachine = defineExecutorMachine({
  id: 'adhoc-executor', version: 1, initial: 'ANALYZE',
  states: {
    ANALYZE: { operation: 'runTechLeadAnalysis', transitions: { COMPLETE: 'DONE', NEEDS_HUMAN: 'FAILED' } },
    DONE: {}, FAILED: {},
  },
});
