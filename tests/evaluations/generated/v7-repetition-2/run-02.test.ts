import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

const validInput: CreatePaymentInput = { amount: 1000, currency: "usd", source: "tok_visa" };

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
  call: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

function createPayment(overrides: Partial<CreatePaymentInput> = {}) {
  return client.createPayment({ ...validInput, ...overrides });
}

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await createPayment({ amount: 2500, currency: "eur" });

    expect(payment.id).toMatch(/^pay_/);
    expect(payment).toEqual({
      id: payment.id,
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: payment.createdAt,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await createPayment({ source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await createPayment();
    const second = await createPayment();

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      createPayment({ source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      createPayment({ source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      createPayment({ source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      createPayment({ source: "tok_bogus" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero amount", { amount: 0 }],
    ["negative amount", { amount: -5 }],
    ["fractional amount", { amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, overrides) => {
    await expectApiError(createPayment(overrides), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as CreatePaymentInput;

    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment(validInput),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(createPayment({ source: "tok_chargeDeclined" }), 402, "card_declined");

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await createPayment();

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id so it cannot escape the path segment", async () => {
    await expectApiError(
      client.getPayment("a/b"),
      404,
      "payment_not_found",
      "No payment with id a/b",
    );
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    const created = await createPayment();

    await expectApiError(badKeyClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const succeeded = await createPayment();
    const pending = await createPayment({ source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.find((p) => p.id === succeeded.id)).toEqual(succeeded);
    expect(payments.find((p) => p.id === pending.id)).toEqual(pending);
  });

  test("returns only payments matching the status filter", async () => {
    await createPayment();
    const pending = await createPayment({ source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await createPayment();

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("reflects status changes made through other methods", async () => {
    const pending = await createPayment({ source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
    expect(await client.listPayments({ status: "pending" })).toEqual([]);
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("refunds the full amount by default", async () => {
    const created = await createPayment({ amount: 1000 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await createPayment({ amount: 1000 });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await createPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment returns it", async () => {
    const created = await createPayment({ amount: 1000 });
    const refunded = await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await createPayment();
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const pending = await createPayment({ source: "tok_pending" });

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await createPayment({ source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await createPayment({ amount: 1000 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("measures the limit against the remaining balance after a partial refund", async () => {
    const created = await createPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await createPayment({ amount: 1000 });

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    const created = await createPayment();

    await expectApiError(badKeyClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await createPayment({ source: "tok_pending" });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toEqual({ ...pending, status: "canceled" });
  });

  test("persists the cancellation so getPayment returns it", async () => {
    const pending = await createPayment({ source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.getPayment(pending.id)).toEqual(canceled);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.cancelPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await createPayment();

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const pending = await createPayment({ source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.cancelPayment(pending.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    const pending = await createPayment({ source: "tok_pending" });

    await expectApiError(badKeyClient.cancelPayment(pending.id), 401, "unauthorized");
  });
});

describe("error responses without a standard error body", () => {
  test("falls back to unknown_error and the status text when the body is not JSON", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () =>
        HttpResponse.text("<html>bad gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
        }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments`, () =>
        HttpResponse.json({ detail: "boom" }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.listPayments(), 503, "unknown_error", "Service Unavailable");
  });
});
