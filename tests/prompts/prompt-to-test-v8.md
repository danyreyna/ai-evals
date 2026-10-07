# Task

Write tests for `PaymentsClient` in `src/payments.test.ts`. Cover the happy path of every method and the error responses the mock server can return.

# Context

`PaymentsClient` is defined in `src/index.ts` and calls the MSW mock server defined in `src/mocks/handlers.ts`.

# Constraints

- Every test that expects a `PaymentsApiError` must assert both the HTTP status and the error code, even if it also checks the message.
- Every test must assert on the value the client call returns or on the `PaymentsApiError` it throws. Never swallow a rejection with `.catch`, and never assert only on a captured request.
