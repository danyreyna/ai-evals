import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

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
  const error = await promise.then(
    () => {
      throw new Error("expected the request to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  if (message !== undefined) {
    expect(apiError.message).toBe(message);
  }
}

const createSucceeded = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_visa" });

const createPending = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_pending" });

describe("createPayment", () => {
  test("creates a succeeded payment for a valid source", async () => {
    const payment = await createSucceeded(2500);

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await createPending();

    expect(payment.status).toBe("pending");
    expect(payment.source).toBe("tok_pending");
  });

  test("rejects a non-positive amount with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ amount: 0, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
      "amount (positive integer), currency and source are required",
    );
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ amount: 10.5, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
    );
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_nope" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test("returns 401 unauthorized for an invalid API key", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test("returns 402 card_declined for tok_chargeDeclined", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("returns 402 insufficient_funds for tok_insufficientFunds", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("returns 500 processing_error for tok_serverError", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("retrieves an existing payment", async () => {
    const created = await createSucceeded();

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id", async () => {
    await expectApiError(
      client.getPayment("a/b c"),
      404,
      "payment_not_found",
      "No payment with id a/b c",
    );
  });

  test("returns 401 unauthorized for an invalid API key", async () => {
    const created = await createSucceeded();

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments when no filter is given", async () => {
    const a = await createSucceeded(100);
    const b = await createPending(200);

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters payments by status", async () => {
    const succeeded = await createSucceeded(100);
    const pending = await createPending(200);

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty list when no payment matches the status", async () => {
    await createSucceeded();

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("returns 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.id).toBe(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds a payment when an amount is given", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("refunds the remaining balance of a partially refunded payment", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("returns 409 already_refunded for a fully refunded payment", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("returns 409 not_refundable for a pending payment", async () => {
    const created = await createPending();

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("returns 409 not_refundable for a canceled payment", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("returns 422 invalid_refund_amount when the amount exceeds the payment", async () => {
    const created = await createSucceeded(1000);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("returns 422 invalid_refund_amount when the amount exceeds the remaining balance", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });

  test("returns 422 invalid_refund_amount for a zero amount", async () => {
    const created = await createSucceeded();

    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("returns 422 invalid_refund_amount for a non-integer amount", async () => {
    const created = await createSucceeded();

    await expectApiError(
      client.refundPayment(created.id, { amount: 10.5 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("returns 401 unauthorized for an invalid API key", async () => {
    const created = await createSucceeded();

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await createPending();

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("returns 409 not_cancelable for a succeeded payment", async () => {
    const created = await createSucceeded();

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("returns 409 not_cancelable for an already canceled payment", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(
      client.cancelPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("returns 401 unauthorized for an invalid API key", async () => {
    const created = await createPending();

    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });
});

describe("error fallback", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () =>
        HttpResponse.text("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });
});
