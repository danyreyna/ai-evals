import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

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

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

const validInput: CreatePaymentInput = { amount: 1000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected the call to reject with PaymentsApiError");
    },
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(PaymentsApiError);
  expect(error).toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

describe("createPayment", () => {
  test("creates a succeeded payment from tok_visa", async () => {
    const payment = await client.createPayment(validInput);

    const { id, createdAt, ...rest } = payment;

    expect(rest).toEqual({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(id).toMatch(/^pay_/);
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });

  test("creates a pending payment from tok_pending", async () => {
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

  test("surfaces a processing failure as 500 processing_error", async () => {
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

  test("rejects a zero amount with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, amount: 0 }),
      400,
      "invalid_request",
    );
  });

  test("rejects a negative amount with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, amount: -5 }),
      400,
      "invalid_request",
    );
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, amount: 10.5 }),
      400,
      "invalid_request",
    );
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as CreatePaymentInput;

    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment(validInput),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test("does not store a payment that was rejected", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(validInput);

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

  test("url-encodes the id so it stays a single path segment", async () => {
    await expectApiError(
      client.getPayment("a/b?c"),
      404,
      "payment_not_found",
      "No payment with id a/b?c",
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

    expect(await client.listPayments()).toEqual([succeeded, pending]);
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await client.createPayment(validInput);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes made by refund and cancel", async () => {
    const toRefund = await client.createPayment(validInput);
    const toCancel = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.refundPayment(toRefund.id);
    await client.cancelPayment(toCancel.id);

    const refunded = await client.listPayments({ status: "refunded" });
    const canceled = await client.listPayments({ status: "canceled" });

    expect(refunded.map((p) => p.id)).toEqual([toRefund.id]);
    expect(canceled.map((p) => p.id)).toEqual([toCancel.id]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds only the remainder after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("allows several partial refunds that sum to the full amount", async () => {
    const created = await client.createPayment(validInput);

    const first = await client.refundPayment(created.id, { amount: 250 });
    const second = await client.refundPayment(created.id, { amount: 750 });

    expect(first.status).toBe("partially_refunded");
    expect(first.amountRefunded).toBe(250);
    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(validInput);
    const refunded = await client.refundPayment(created.id, { amount: 100 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
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
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the payment with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects an amount above the remainder with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 900 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 101 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 100",
    );
  });

  test("rejects a zero amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a non-integer amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1.5 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(validInput);
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(badKeyClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toEqual({ ...pending, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.getPayment(pending.id)).toEqual(canceled);
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
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.cancelPayment(pending.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A refunded payment cannot be canceled",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.cancelPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(badKeyClient.cancelPayment(pending.id), 401, "unauthorized");
  });
});

describe("error parsing", () => {
  test("falls back to unknown_error and the status text for a non-JSON error body", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_x",
        () =>
          new HttpResponse("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_x"), 502, "unknown_error", "Bad Gateway");
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments/pay_x", () =>
        HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_x"), 503, "unknown_error", "Service Unavailable");
  });
});

describe("client configuration", () => {
  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://staging.example.com/v2/payments", () => HttpResponse.json({ data: [] })),
    );
    const staging = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://staging.example.com/v2",
    });

    expect(await staging.listPayments()).toEqual([]);
  });
});
