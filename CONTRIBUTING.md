# Contributing

This project follows test-driven development for behavioral changes.

1. Add or change a test that captures the desired logical contract.
2. Confirm the test fails for the expected reason.
3. Implement the smallest behavior that makes it pass.
4. Refactor without changing the contract.
5. Keep workflow semantics independent from specific agent/model providers.

Reliability changes should prefer bounded, idempotent mechanisms over intelligent orchestration.
