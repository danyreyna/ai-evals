import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  resetPayments();
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

const visa = (amount = 1000): CreatePaymentInput => ({
  amount,
  currency: "usd",
  source: "tok_visa",
});

const pending = (amount = 1000): CreatePaymentInput => ({
  amount,
  currency: "usd",
  source: "tok_pending",
});

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(visa(2500));

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_.+/),
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(pending(700));

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(700);
    expect(payment.source).toBe("tok_pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment(visa());
    const second = await client.createPayment(visa());

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processor failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_nope" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(client.createPayment(visa(amount)), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as CreatePaymentInput;

    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment(visa()),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(visa(1800));

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

  test("url-encodes the id so it reaches the server intact", async () => {
    await expectApiError(
      client.getPayment("a/b c?d"),
      404,
      "payment_not_found",
      "No payment with id a/b c?d",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa());

    await expectApiError(badKeyClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(visa(100));
    const b = await client.createPayment(pending(200));

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment(visa(100));
    const pendingPayment = await client.createPayment(pending(200));

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "pending" })).toEqual([pendingPayment]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(visa());

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("returns all payments when the filter object has no status", async () => {
    await client.createPayment(visa());
    await client.createPayment(pending());

    expect(await client.listPayments({})).toHaveLength(2);
  });

  test("reflects status changes in filtered results", async () => {
    const payment = await client.createPayment(pending());
    await client.cancelPayment(payment.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    const canceled = await client.listPayments({ status: "canceled" });
    expect(canceled.map((p) => p.id)).toEqual([payment.id]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await client.createPayment(visa(1000));

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount below the total is given", async () => {
    const created = await client.createPayment(visa(1000));

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
    expect(refunded.amount).toBe(1000);
    expect(refunded.id).toBe(created.id);
  });

  test("refunds the exact total when the amount equals the payment amount", async () => {
    const created = await client.createPayment(visa(1000));

    const refunded = await client.refundPayment(created.id, { amount: 1000 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("accumulates partial refunds until the payment is fully refunded", async () => {
    const created = await client.createPayment(visa(1000));

    const first = await client.refundPayment(created.id, { amount: 300 });
    const second = await client.refundPayment(created.id, { amount: 300 });
    const rest = await client.refundPayment(created.id);

    expect(first.amountRefunded).toBe(300);
    expect(first.status).toBe("partially_refunded");
    expect(second.amountRefunded).toBe(600);
    expect(second.status).toBe("partially_refunded");
    expect(rest.amountRefunded).toBe(1000);
    expect(rest.status).toBe("refunded");
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(visa(1000));
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("rejects a refund above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa(1000));

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("measures the limit against the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(visa(1000));
    await client.refundPayment(created.id, { amount: 800 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 201 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 200",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await client.createPayment(visa(1000));

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("does not change the payment when a refund is rejected", async () => {
    const created = await client.createPayment(visa(1000));
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(visa(1000));
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending());

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending());
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa());

    await expectApiError(badKeyClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(pending(900));

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const created = await client.createPayment(pending());
    await client.cancelPayment(created.id);

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("canceled");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa());

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(pending());
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa());
    await client.refundPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A refunded payment cannot be canceled",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(pending());

    await expectApiError(badKeyClient.cancelPayment(created.id), 401, "unauthorized");
  });
});

describe("error body handling", () => {
  test("falls back to unknown_error and statusText when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("upstream down", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });

  test("falls back to unknown_error when the JSON error body has no error object", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments`,
        () => HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.listPayments(), 503, "unknown_error", "Service Unavailable");
  });
});
