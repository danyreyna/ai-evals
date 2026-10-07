import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

const charge = { amount: 1000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  call: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
  resetPayments();
});
afterAll(() => {
  server.close();
});

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment(charge);

    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...charge, source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid amount with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ ...charge, amount: -5 }),
      400,
      "invalid_request",
      "amount (positive integer), currency and source are required",
    );
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment({ ...charge, amount: 10.5 }), 400, "invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...charge, source: "tok_nope" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...charge, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...charge, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...charge, source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment(charge),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment(charge);

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

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.getPayment("pay_any"), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await client.createPayment(charge);
    const b = await client.createPayment({ ...charge, source: "tok_pending" });

    expect(await client.listPayments()).toEqual([a, b]);
  });

  test("filters by status", async () => {
    await client.createPayment(charge);
    const pending = await client.createPayment({ ...charge, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty list when no payment matches the status", async () => {
    await client.createPayment(charge);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(charge);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds a given amount", async () => {
    const created = await client.createPayment(charge);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("completes a refund across two partial refunds", async () => {
    const created = await client.createPayment(charge);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects refunding twice with 409 already_refunded", async () => {
    const created = await client.createPayment(charge);
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...charge, source: "tok_pending" });

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...charge, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(charge);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects an amount above the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(charge);
    await client.refundPayment(created.id, { amount: 400 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 601 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 600",
    );
  });

  test("rejects a zero amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(charge);

    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.refundPayment("pay_any"), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...charge, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(charge);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling twice with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...charge, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.cancelPayment("pay_any"), 401, "unauthorized");
  });
});

describe("non-JSON error responses", () => {
  test("falls back to unknown_error and the status text", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_x",
        () => new HttpResponse("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_x"), 502, "unknown_error", "Bad Gateway");
  });
});
