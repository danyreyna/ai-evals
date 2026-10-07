import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  resetPayments();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(promise).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

const createSucceeded = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_visa" });

const createPending = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_pending" });

test("createPayment returns a succeeded payment for a valid card", async () => {
  const payment = await client.createPayment({ amount: 2500, currency: "usd", source: "tok_visa" });

  expect(payment).toEqual({
    id: expect.stringMatching(/^pay_/),
    amount: 2500,
    currency: "usd",
    source: "tok_visa",
    status: "succeeded",
    amountRefunded: 0,
    createdAt: expect.any(String),
  });
  expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
});

test("createPayment returns a pending payment for the pending source", async () => {
  const payment = await createPending(700);

  expect(payment.status).toBe("pending");
  expect(payment.amount).toBe(700);
  expect(payment.amountRefunded).toBe(0);
});

test("createPayment gives each payment a distinct id", async () => {
  const first = await createSucceeded();
  const second = await createSucceeded();

  expect(first.id).not.toBe(second.id);
});

test("createPayment rejects a declined card with 402 card_declined", async () => {
  await expectApiError(
    client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
    402,
    "card_declined",
    "The card was declined",
  );
});

test("createPayment rejects insufficient funds with 402 insufficient_funds", async () => {
  await expectApiError(
    client.createPayment({ amount: 1000, currency: "usd", source: "tok_insufficientFunds" }),
    402,
    "insufficient_funds",
    "The card has insufficient funds",
  );
});

test("createPayment surfaces a server failure as 500 processing_error", async () => {
  await expectApiError(
    client.createPayment({ amount: 1000, currency: "usd", source: "tok_serverError" }),
    500,
    "processing_error",
    "An error occurred while processing the payment",
  );
});

test("createPayment rejects an unknown source with 400 invalid_source", async () => {
  await expectApiError(
    client.createPayment({ amount: 1000, currency: "usd", source: "tok_nope" }),
    400,
    "invalid_source",
    "Unknown payment source",
  );
});

test("createPayment rejects a zero amount with 400 invalid_request", async () => {
  await expectApiError(
    client.createPayment({ amount: 0, currency: "usd", source: "tok_visa" }),
    400,
    "invalid_request",
  );
});

test("createPayment rejects a negative amount with 400 invalid_request", async () => {
  await expectApiError(
    client.createPayment({ amount: -5, currency: "usd", source: "tok_visa" }),
    400,
    "invalid_request",
  );
});

test("createPayment rejects a fractional amount with 400 invalid_request", async () => {
  await expectApiError(
    client.createPayment({ amount: 10.5, currency: "usd", source: "tok_visa" }),
    400,
    "invalid_request",
  );
});

test("createPayment rejects a bad API key with 401 unauthorized", async () => {
  const badClient = new PaymentsClient({ apiKey: "wrong_key" });

  await expectApiError(
    badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
    401,
    "unauthorized",
    "Missing or invalid API key",
  );
});

test("getPayment returns the payment that was created", async () => {
  const created = await createSucceeded(1800);

  const fetched = await client.getPayment(created.id);

  expect(fetched).toEqual(created);
});

test("getPayment rejects an unknown id with 404 payment_not_found", async () => {
  await expectApiError(
    client.getPayment("pay_missing"),
    404,
    "payment_not_found",
    "No payment with id pay_missing",
  );
});

test("getPayment url-encodes the id so it is looked up verbatim", async () => {
  await expectApiError(
    client.getPayment("a/b c"),
    404,
    "payment_not_found",
    "No payment with id a/b c",
  );
});

test("getPayment rejects a bad API key with 401 unauthorized", async () => {
  const created = await createSucceeded();
  const badClient = new PaymentsClient({ apiKey: "wrong_key" });

  await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
});

test("listPayments returns an empty array when there are no payments", async () => {
  expect(await client.listPayments()).toEqual([]);
});

test("listPayments returns every payment when no filter is given", async () => {
  const succeeded = await createSucceeded(100);
  const pending = await createPending(200);

  const payments = await client.listPayments();

  expect(payments).toHaveLength(2);
  expect(payments).toEqual(expect.arrayContaining([succeeded, pending]));
});

test("listPayments filters by status", async () => {
  const succeeded = await createSucceeded(100);
  await createPending(200);

  const payments = await client.listPayments({ status: "succeeded" });

  expect(payments).toEqual([succeeded]);
});

test("listPayments returns an empty array when no payment matches the status", async () => {
  await createSucceeded();

  expect(await client.listPayments({ status: "canceled" })).toEqual([]);
});

test("listPayments reflects status changes made through other methods", async () => {
  const pending = await createPending();
  const canceled = await client.cancelPayment(pending.id);

  expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  expect(await client.listPayments({ status: "pending" })).toEqual([]);
});

test("listPayments rejects a bad API key with 401 unauthorized", async () => {
  const badClient = new PaymentsClient({ apiKey: "wrong_key" });

  await expectApiError(badClient.listPayments(), 401, "unauthorized");
});

test("refundPayment with no amount refunds the full payment", async () => {
  const created = await createSucceeded(1000);

  const refunded = await client.refundPayment(created.id);

  expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
});

test("refundPayment with an amount partially refunds the payment", async () => {
  const created = await createSucceeded(1000);

  const refunded = await client.refundPayment(created.id, { amount: 400 });

  expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
});

test("refundPayment can finish a partially refunded payment", async () => {
  const created = await createSucceeded(1000);
  await client.refundPayment(created.id, { amount: 400 });

  const refunded = await client.refundPayment(created.id, { amount: 600 });

  expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
});

test("refundPayment without an amount refunds only the remaining balance", async () => {
  const created = await createSucceeded(1000);
  await client.refundPayment(created.id, { amount: 300 });

  const refunded = await client.refundPayment(created.id);

  expect(refunded.status).toBe("refunded");
  expect(refunded.amountRefunded).toBe(1000);
});

test("refundPayment persists the refund so getPayment sees it", async () => {
  const created = await createSucceeded(1000);
  await client.refundPayment(created.id, { amount: 250 });

  const fetched = await client.getPayment(created.id);

  expect(fetched.amountRefunded).toBe(250);
  expect(fetched.status).toBe("partially_refunded");
});

test("refundPayment rejects an unknown id with 404 payment_not_found", async () => {
  await expectApiError(
    client.refundPayment("pay_missing"),
    404,
    "payment_not_found",
    "No payment with id pay_missing",
  );
});

test("refundPayment rejects a fully refunded payment with 409 already_refunded", async () => {
  const created = await createSucceeded();
  await client.refundPayment(created.id);

  await expectApiError(
    client.refundPayment(created.id),
    409,
    "already_refunded",
    "Payment already refunded",
  );
});

test("refundPayment rejects a pending payment with 409 not_refundable", async () => {
  const pending = await createPending();

  await expectApiError(
    client.refundPayment(pending.id),
    409,
    "not_refundable",
    "A pending payment cannot be refunded",
  );
});

test("refundPayment rejects a canceled payment with 409 not_refundable", async () => {
  const pending = await createPending();
  await client.cancelPayment(pending.id);

  await expectApiError(
    client.refundPayment(pending.id),
    409,
    "not_refundable",
    "A canceled payment cannot be refunded",
  );
});

test("refundPayment rejects an amount above the payment with 422 invalid_refund_amount", async () => {
  const created = await createSucceeded(1000);

  await expectApiError(
    client.refundPayment(created.id, { amount: 1001 }),
    422,
    "invalid_refund_amount",
    "Refund amount must be between 1 and 1000",
  );
});

test("refundPayment rejects an amount above the remaining balance with 422", async () => {
  const created = await createSucceeded(1000);
  await client.refundPayment(created.id, { amount: 700 });

  await expectApiError(
    client.refundPayment(created.id, { amount: 400 }),
    422,
    "invalid_refund_amount",
    "Refund amount must be between 1 and 300",
  );
});

test("refundPayment rejects a zero amount with 422 invalid_refund_amount", async () => {
  const created = await createSucceeded(1000);

  await expectApiError(
    client.refundPayment(created.id, { amount: 0 }),
    422,
    "invalid_refund_amount",
  );
});

test("refundPayment rejects a negative amount with 422 invalid_refund_amount", async () => {
  const created = await createSucceeded(1000);

  await expectApiError(
    client.refundPayment(created.id, { amount: -1 }),
    422,
    "invalid_refund_amount",
  );
});

test("refundPayment rejects a bad API key with 401 unauthorized", async () => {
  const created = await createSucceeded();
  const badClient = new PaymentsClient({ apiKey: "wrong_key" });

  await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
});

test("cancelPayment cancels a pending payment", async () => {
  const pending = await createPending();

  const canceled = await client.cancelPayment(pending.id);

  expect(canceled).toEqual({ ...pending, status: "canceled" });
});

test("cancelPayment persists the cancellation so getPayment sees it", async () => {
  const pending = await createPending();
  await client.cancelPayment(pending.id);

  const fetched = await client.getPayment(pending.id);

  expect(fetched.status).toBe("canceled");
});

test("cancelPayment rejects an unknown id with 404 payment_not_found", async () => {
  await expectApiError(
    client.cancelPayment("pay_missing"),
    404,
    "payment_not_found",
    "No payment with id pay_missing",
  );
});

test("cancelPayment rejects a succeeded payment with 409 not_cancelable", async () => {
  const created = await createSucceeded();

  await expectApiError(
    client.cancelPayment(created.id),
    409,
    "not_cancelable",
    "A succeeded payment cannot be canceled",
  );
});

test("cancelPayment rejects an already canceled payment with 409 not_cancelable", async () => {
  const pending = await createPending();
  await client.cancelPayment(pending.id);

  await expectApiError(
    client.cancelPayment(pending.id),
    409,
    "not_cancelable",
    "A canceled payment cannot be canceled",
  );
});

test("cancelPayment rejects a bad API key with 401 unauthorized", async () => {
  const pending = await createPending();
  const badClient = new PaymentsClient({ apiKey: "wrong_key" });

  await expectApiError(badClient.cancelPayment(pending.id), 401, "unauthorized");
});

test("a non-JSON error body falls back to unknown_error and the status text", async () => {
  server.use(
    http.get(
      "https://api.example.com/v1/payments/:id",
      () => new HttpResponse("upstream down", { status: 502, statusText: "Bad Gateway" }),
    ),
  );

  await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
});

test("a custom baseUrl is used for requests", async () => {
  const payment: Payment = {
    id: "pay_custom",
    amount: 1,
    currency: "usd",
    source: "tok_visa",
    status: "succeeded",
    amountRefunded: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  server.use(
    http.get("https://custom.example.com/api/payments/pay_custom", () =>
      HttpResponse.json(payment),
    ),
  );
  const customClient = new PaymentsClient({
    apiKey: "test_key",
    baseUrl: "https://custom.example.com/api",
  });

  expect(await customClient.getPayment("pay_custom")).toEqual(payment);
});
