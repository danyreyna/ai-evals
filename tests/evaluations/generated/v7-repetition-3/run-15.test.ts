import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: BASE_URL });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

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
  // oxlint-disable-next-line typescript/await-thenable -- bun-types does not type `.rejects` as thenable
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  // oxlint-disable-next-line typescript/await-thenable -- bun-types does not type `.rejects` as thenable
  await expect(promise).rejects.toMatchObject({
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

const validInput: CreatePaymentInput = { amount: 5000, currency: "usd", source: "tok_visa" };

describe("createPayment", () => {
  test("returns a succeeded payment echoing the input", async () => {
    const payment = await client.createPayment(validInput);

    expect(payment.id).toMatch(/^pay_/);
    expect(payment).toEqual({
      ...validInput,
      id: payment.id,
      status: "succeeded",
      amountRefunded: 0,
      createdAt: payment.createdAt,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("generates a distinct id for each payment", async () => {
    const first = await client.createPayment(validInput);
    const second = await client.createPayment(validInput);

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_nope" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero amount", { ...validInput, amount: 0 }],
    ["negative amount", { ...validInput, amount: -100 }],
    ["fractional amount", { ...validInput, amount: 10.5 }],
    ["missing currency", { amount: 100, source: "tok_visa" }],
    ["missing source", { amount: 100, currency: "usd" }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input as CreatePaymentInput), 400, "invalid_request");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment(validInput),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(validInput);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(badKeyClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual(pending);
    expect(payments).toContainEqual(succeeded);
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment(validInput);
    await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(validInput);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes in filtered results", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    const canceled = await client.cancelPayment(created.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 5000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 1200 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 1200 });
  });

  test("accumulates partial refunds and ends as refunded", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 2000 });

    const second = await client.refundPayment(created.id, { amount: 3000 });

    expect(second).toEqual({ ...created, status: "refunded", amountRefunded: 5000 });
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 2000 });

    const rest = await client.refundPayment(created.id);

    expect(rest).toEqual({ ...created, status: "refunded", amountRefunded: 5000 });
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 100 });

    expect(await client.getPayment(created.id)).toEqual({
      ...created,
      status: "partially_refunded",
      amountRefunded: 100,
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects a refund above the amount paid with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount: 5001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 5000",
    );
  });

  test("rejects a refund above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 4000 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(badKeyClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    expect((await client.getPayment(created.id)).status).toBe("canceled");
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
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(badKeyClient.cancelPayment(created.id), 401, "unauthorized");
  });
});

describe("request encoding and error fallbacks", () => {
  test("URL-encodes ids that contain reserved characters", async () => {
    await expectApiError(
      client.getPayment("a b/c?d"),
      404,
      "payment_not_found",
      "No payment with id a b/c?d",
    );
  });

  test("falls back to unknown_error and statusText when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("upstream down", { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 503, "unknown_error", "Service Unavailable");
  });

  test("falls back to unknown_error when the error JSON has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () =>
        HttpResponse.json({ oops: true }, { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });
});
