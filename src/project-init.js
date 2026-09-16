export function validateProjectInit(input) {
  if (!input?.projectName) throw new Error('projectName is required');
  if (input.repo?.mode === 'existing' && !input.repo.remote) throw new Error('existing repo remote is required');
  if (!input.repo?.defaultBranch) throw new Error('defaultBranch is required');
  if (input.sourceControl?.reviewerCanPush) throw new Error('reviewerCanPush must be false');
  return true;
}

export function planProjectInit(input) {
  validateProjectInit(input);
  return {
    kind: 'PROJECT_INIT',
    steps: [
      { kind: 'validate_repo' },
      { kind: 'configure_source_control' },
      { kind: 'bootstrap_ariad' },
      { kind: 'collect_project_requirements' },
      { kind: 'start_workflow' },
    ],
    capabilities: {
      pm: ['read_project','propose_plan'],
      developer: ['read_repo','write_workspace'],
      tester: ['read_repo','run_tests'],
      reviewer: ['read_repo','review_evidence'],
      project_debugger: ['read_history','diagnose_project'],
      system_debugger: ['read_incident','diagnose_system'],
    },
    sourceControl: {
      ...input.sourceControl,
      finalizer: 'source_control_step',
      trigger: 'reviewer_pass',
    }
  };
}
