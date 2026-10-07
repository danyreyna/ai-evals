import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

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
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status: expected.status,
    code: expected.code,
    ...(expected.message !== undefined && { message: expected.message }),
  });
}

const visa = { amount: 1000, currency: "usd", source: "tok_visa" };

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment(visa);

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...visa, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(1000);
    expect(payment.amountRefunded).toBe(0);
  });

  test("returns a distinct id for each payment", async () => {
    const first = await client.createPayment(visa);
    const second = await client.createPayment(visa);

    expect(first.id).not.toBe(second.id);
  });

  test("throws 402 card_declined for a declined card", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("throws 402 insufficient_funds when the card has no funds", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("throws 500 processing_error on a server failure", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("throws 400 invalid_source for an unknown source", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_bogus" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero amount", { ...visa, amount: 0 }],
    ["negative amount", { ...visa, amount: -5 }],
    ["fractional amount", { ...visa, amount: 10.5 }],
  ])("throws 400 invalid_request for a %s", async (_name, input) => {
    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("throws 400 invalid_request when currency is missing", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];

    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("throws 401 unauthorized with a bad API key", async () => {
    await expectApiError(badKeyClient.createPayment(visa), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(visa);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("reflects state changes made after creation", async () => {
    const created = await client.createPayment({ ...visa, source: "tok_pending" });
    await client.cancelPayment(created.id);

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("canceled");
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id so it cannot escape the payment path", async () => {
    await expectApiError(client.getPayment("a/b?c=d"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b?c=d",
    });
  });

  test("throws 401 unauthorized with a bad API key", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(badKeyClient.getPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(visa);
    const b = await client.createPayment({ ...visa, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment(visa);
    const pending = await client.createPayment({ ...visa, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(visa);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("throws 401 unauthorized with a bad API key", async () => {
    await expectApiError(badKeyClient.listPayments(), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("accumulates partial refunds and ends as refunded", async () => {
    const created = await client.createPayment(visa);

    const first = await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });

    expect(first.status).toBe("partially_refunded");
    expect(second).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("refunds only the remainder after a partial refund", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 300 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.amountRefunded).toBe(1000);
    expect(refunded.status).toBe("refunded");
  });

  test("throws 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("throws 409 not_refundable for a pending payment", async () => {
    const created = await client.createPayment({ ...visa, source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("throws 409 not_refundable for a canceled payment", async () => {
    const created = await client.createPayment({ ...visa, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("throws 422 invalid_refund_amount when exceeding the remaining amount", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 800 });

    await expectApiError(client.refundPayment(created.id, { amount: 201 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 200",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("throws 422 invalid_refund_amount for a %s amount", async (_name, amount) => {
    const created = await client.createPayment(visa);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("does not change the payment when a refund is rejected", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.refundPayment(created.id, { amount: 5000 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("throws 401 unauthorized with a bad API key", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(badKeyClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...visa, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("throws 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("throws 409 not_cancelable for an already canceled payment", async () => {
    const created = await client.createPayment({ ...visa, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("throws 401 unauthorized with a bad API key", async () => {
    const created = await client.createPayment({ ...visa, source: "tok_pending" });

    await expectApiError(badKeyClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error handling", () => {
  test("falls back to unknown_error when the error body is not JSON", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () =>
        HttpResponse.text("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://staging.example.com/v2/payments/:id", () =>
        HttpResponse.json({
          id: "pay_staging",
          amount: 1,
          currency: "usd",
          source: "tok_visa",
          status: "succeeded",
          amountRefunded: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        } satisfies Payment),
      ),
    );
    const staging = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://staging.example.com/v2",
    });

    const payment = await staging.getPayment("pay_staging");

    expect(payment.id).toBe("pay_staging");
  });
});
