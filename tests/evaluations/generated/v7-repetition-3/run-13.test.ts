import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: BASE_URL });
const unauthorizedClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

const validInput: CreatePaymentInput = { amount: 2000, currency: "usd", source: "tok_visa" };

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
  expected: { status: number; code: string; message?: string },
) {
  // bun's `rejects` matchers return promises at runtime; its types do not declare them thenable.
  // oxlint-disable-next-line typescript/await-thenable
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  // oxlint-disable-next-line typescript/await-thenable
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    ...expected,
  });
}

const createSucceeded = (amount = 2000) => client.createPayment({ ...validInput, amount });
const createPending = () => client.createPayment({ ...validInput, source: "tok_pending" });

describe("createPayment", () => {
  test("creates a succeeded payment echoing the input", async () => {
    const payment = await client.createPayment(validInput);

    expect(payment.id).toMatch(/^pay_.+/);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
    expect(payment).toEqual({
      id: payment.id,
      amount: 2000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: payment.createdAt,
    });
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.source).toBe("tok_pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment(validInput);
    const second = await client.createPayment(validInput);

    expect(first.id).not.toBe(second.id);
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await client.createPayment(validInput);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(client.createPayment({ ...validInput, amount }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 2000, source: "tok_visa" } as unknown as CreatePaymentInput;

    await expectApiError(client.createPayment(input), { status: 400, code: "invalid_request" });
  });

  test("rejects a bad request without storing a payment", async () => {
    await expectApiError(client.createPayment({ ...validInput, amount: 0 }), {
      status: 400,
      code: "invalid_request",
    });

    expect(await client.listPayments()).toEqual([]);
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    await expectApiError(unauthorizedClient.createPayment(validInput), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await createSucceeded();

    const payment = await client.getPayment(created.id);

    expect(payment).toEqual(created);
  });

  test("returns the current state after a mutation", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);

    const payment = await client.getPayment(created.id);

    expect(payment).toEqual({ ...created, status: "canceled" });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes ids so they cannot alter the path", async () => {
    await expectApiError(client.getPayment("a/b"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    const created = await createSucceeded();

    await expectApiError(unauthorizedClient.getPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when unfiltered", async () => {
    const succeeded = await createSucceeded();
    const pending = await createPending();

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual(succeeded);
    expect(payments).toContainEqual(pending);
  });

  test("filters by status", async () => {
    await createSucceeded();
    const pending = await createPending();

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await createSucceeded();

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes in the filter", async () => {
    const pending = await createPending();
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    await expectApiError(unauthorizedClient.listPayments(), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await createSucceeded(2000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 2000 });
  });

  test("partially refunds a given amount", async () => {
    const created = await createSucceeded(2000);

    const refunded = await client.refundPayment(created.id, { amount: 500 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 500 });
  });

  test("accumulates partial refunds and ends as refunded", async () => {
    const created = await createSucceeded(2000);

    const first = await client.refundPayment(created.id, { amount: 500 });
    const second = await client.refundPayment(created.id, { amount: 1500 });

    expect(first.amountRefunded).toBe(500);
    expect(first.status).toBe("partially_refunded");
    expect(second).toEqual({ ...created, status: "refunded", amountRefunded: 2000 });
  });

  test("refunds the remainder after a partial refund when no amount is given", async () => {
    const created = await createSucceeded(2000);
    await client.refundPayment(created.id, { amount: 500 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 2000 });
  });

  test("persists the refund so it can be retrieved", async () => {
    const created = await createSucceeded(2000);
    const refunded = await client.refundPayment(created.id, { amount: 700 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects an already refunded payment with 409 already_refunded", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects a pending payment with 409 not_refundable", async () => {
    const created = await createPending();

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects a canceled payment with 409 not_refundable", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects an amount above the payment with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(2000);

    await expectApiError(client.refundPayment(created.id, { amount: 2001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 2000",
    });
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(2000);
    await client.refundPayment(created.id, { amount: 1500 });

    await expectApiError(client.refundPayment(created.id, { amount: 501 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 500",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await createSucceeded(2000);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await createSucceeded(2000);
    await expectApiError(client.refundPayment(created.id, { amount: 5000 }), {
      status: 422,
      code: "invalid_refund_amount",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    const created = await createSucceeded();

    await expectApiError(unauthorizedClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await createPending();

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so it can be retrieved", async () => {
    const created = await createPending();
    const canceled = await client.cancelPayment(created.id);

    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects a succeeded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects an already canceled payment with 409 not_cancelable", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects a refunded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A refunded payment cannot be canceled",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid api key with 401 unauthorized", async () => {
    const created = await createPending();

    await expectApiError(unauthorizedClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error responses without a standard body", () => {
  test("falls back to unknown_error and the status text for a non-JSON body", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () => {
        return new HttpResponse("<html>bad gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
        });
      }),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments`, () => {
        return HttpResponse.json(
          { oops: true },
          { status: 503, statusText: "Service Unavailable" },
        );
      }),
    );

    await expectApiError(client.listPayments(), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});
