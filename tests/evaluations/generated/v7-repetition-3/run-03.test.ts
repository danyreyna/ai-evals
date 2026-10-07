import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({
  apiKey: "test_key",
  baseUrl: "https://api.example.com/v1",
});
const unauthorizedClient = new PaymentsClient({
  apiKey: "wrong_key",
  baseUrl: "https://api.example.com/v1",
});

const visa = { amount: 1000, currency: "usd", source: "tok_visa" };
const pending = { amount: 500, currency: "usd", source: "tok_pending" };

async function expectApiError(
  call: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status: expected.status,
    code: expected.code,
    ...(expected.message !== undefined && { message: expected.message }),
  });
}

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

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(visa);

    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(new Date(payment.createdAt).toISOString()).toBe(payment.createdAt);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(pending);

    expect(payment).toMatchObject({
      amount: 500,
      source: "tok_pending",
      status: "pending",
      amountRefunded: 0,
    });
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment(visa);
    const second = await client.createPayment(visa);

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processor failure with 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero amount", { ...visa, amount: 0 }],
    ["negative amount", { ...visa, amount: -100 }],
    ["fractional amount", { ...visa, amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];

    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
    });

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(visa);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("URL-encodes the id so it reaches the server intact", async () => {
    await expectApiError(client.getPayment("a/b"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(visa);
    const b = await client.createPayment(pending);

    expect(await client.listPayments()).toEqual([a, b]);
  });

  test("returns every payment for an empty filter object", async () => {
    const a = await client.createPayment(visa);
    const b = await client.createPayment(pending);

    expect(await client.listPayments({})).toEqual([a, b]);
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(visa);
    const waiting = await client.createPayment(pending);

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "pending" })).toEqual([waiting]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await client.createPayment(visa);

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("reflects status changes made by refund and cancel", async () => {
    const toRefund = await client.createPayment(visa);
    const toCancel = await client.createPayment(pending);
    const refunded = await client.refundPayment(toRefund.id);
    const canceled = await client.cancelPayment(toCancel.id);

    expect(await client.listPayments({ status: "refunded" })).toEqual([refunded]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([]);
    expect(await client.listPayments({ status: "pending" })).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amount: 1000,
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("refunds the remainder of a partially refunded payment", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("accumulates successive partial refunds", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 300 });

    const second = await client.refundPayment(created.id, { amount: 300 });

    expect(second).toMatchObject({ status: "partially_refunded", amountRefunded: 600 });
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(visa);
    const refunded = await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects an amount above the payment with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 800 });

    await expectApiError(client.refundPayment(created.id, { amount: 300 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 200",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(visa);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(visa);
    await expectApiError(client.refundPayment(created.id, { amount: 5000 }), {
      status: 422,
      code: "invalid_refund_amount",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(pending);

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const created = await client.createPayment(pending);
    const canceled = await client.cancelPayment(created.id);

    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A refunded payment cannot be canceled",
    });
  });
});

describe("authentication", () => {
  const unauthorized = {
    status: 401,
    code: "unauthorized",
    message: "Missing or invalid API key",
  };

  test("createPayment rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(unauthorizedClient.createPayment(visa), unauthorized);
  });

  test("getPayment rejects a bad key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(unauthorizedClient.getPayment(created.id), unauthorized);
  });

  test("listPayments rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(unauthorizedClient.listPayments(), unauthorized);
  });

  test("refundPayment rejects a bad key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(unauthorizedClient.refundPayment(created.id), unauthorized);
  });

  test("cancelPayment rejects a bad key with 401 unauthorized", async () => {
    const created = await client.createPayment(pending);

    await expectApiError(unauthorizedClient.cancelPayment(created.id), unauthorized);
  });

  test("checks authorization before resource existence", async () => {
    await expectApiError(unauthorizedClient.getPayment("pay_missing"), unauthorized);
  });
});

describe("non-standard error responses", () => {
  test("falls back to unknown_error when the error body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_x",
        () => new HttpResponse("Bad Gateway", { status: 502 }),
      ),
    );

    await expectApiError(client.getPayment("pay_x"), {
      status: 502,
      code: "unknown_error",
    });
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments", () =>
        HttpResponse.json({ message: "nope" }, { status: 503 }),
      ),
    );

    await expectApiError(client.listPayments(), {
      status: 503,
      code: "unknown_error",
    });
  });
});

test("payments returned by the client match the Payment shape", async () => {
  const payment: Payment = await client.createPayment(visa);

  expect(Object.keys(payment).sort()).toEqual(
    ["amount", "amountRefunded", "createdAt", "currency", "id", "source", "status"].sort(),
  );
});
