import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

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

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  expect(error).toMatchObject({ name: "PaymentsApiError", status, code });
}

const createSucceeded = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_visa" });

const createPending = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_pending" });

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
    });

    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await createPending();
    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid amount with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ amount: 0, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
    );
    await expectApiError(
      client.createPayment({ amount: 10.5, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_nope" }),
      400,
      "invalid_source",
    );
  });

  test("surfaces a declined card as 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
  });

  test("surfaces insufficient funds as 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });

  test("includes the server message on the error", async () => {
    const error = await client
      .createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" })
      .catch((e: unknown) => e);
    expect((error as PaymentsApiError).message).toBe("The card was declined");
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await createSucceeded();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("url-encodes the id in the request path", async () => {
    let requestedPath = "";
    server.use(
      http.get(`${BASE_URL}/payments/:id`, ({ request }) => {
        requestedPath = new URL(request.url).pathname;
        return HttpResponse.json({ id: "x" });
      }),
    );

    await client.getPayment("a/b c");

    expect(requestedPath).toBe("/v1/payments/a%2Fb%20c");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments when no filter is given", async () => {
    const a = await createSucceeded();
    const b = await createPending();

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await createSucceeded();
    const pending = await createPending();

    const payments = await client.listPayments({ status: "pending" });

    expect(payments).toEqual([pending]);
  });

  test("returns an empty list when no payment matches the status", async () => {
    await createSucceeded();
    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("completes a refund across multiple partial refunds", async () => {
    const created = await createSucceeded(1000);

    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second refund with 409 already_refunded", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await createPending();

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 400 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 601 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a zero or fractional amount with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(1000);

    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
    await expectApiError(
      client.refundPayment(created.id, { amount: 1.5 }),
      422,
      "invalid_refund_amount",
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await createPending();

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect(await client.getPayment(created.id)).toMatchObject({ status: "canceled" });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});

describe("authentication", () => {
  const badClient = new PaymentsClient({ apiKey: "wrong_key" });

  test("rejects every method with 401 unauthorized for an invalid key", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
    await expectApiError(badClient.getPayment("pay_any"), 401, "unauthorized");
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
    await expectApiError(badClient.refundPayment("pay_any"), 401, "unauthorized");
    await expectApiError(badClient.cancelPayment("pay_any"), 401, "unauthorized");
  });
});

describe("error fallbacks", () => {
  test("falls back to unknown_error and statusText when the body is not JSON", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () =>
        HttpResponse.text("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    const error = await client.getPayment("pay_any").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentsApiError);
    expect(error).toMatchObject({
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });
});

describe("constructor", () => {
  test("uses a custom baseUrl", async () => {
    server.use(
      http.get("https://custom.example.com/payments", () => HttpResponse.json({ data: [] })),
    );
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://custom.example.com",
    });

    expect(await custom.listPayments()).toEqual([]);
  });
});
