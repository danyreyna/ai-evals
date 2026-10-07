import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

const newPayment = { amount: 1000, currency: "usd", source: "tok_visa" };

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
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to reject");
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

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(newPayment);

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      ...newPayment,
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...newPayment, source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment(newPayment),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test.each([
    ["zero amount", { ...newPayment, amount: 0 }],
    ["negative amount", { ...newPayment, amount: -5 }],
    ["non-integer amount", { ...newPayment, amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...newPayment, source: "tok_bogus" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test("surfaces a declined card as 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...newPayment, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("surfaces insufficient funds as 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...newPayment, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...newPayment, source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ ...newPayment, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment(newPayment);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(newPayment);

    await expectApiError(badKeyClient.getPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id in the request path", async () => {
    await expectApiError(
      client.getPayment("a/b c"),
      404,
      "payment_not_found",
      "No payment with id a/b c",
    );
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments when no filter is given", async () => {
    const a = await client.createPayment(newPayment);
    const b = await client.createPayment({ ...newPayment, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters payments by status", async () => {
    const succeeded = await client.createPayment(newPayment);
    const pending = await client.createPayment({ ...newPayment, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment by default", async () => {
    const created = await client.createPayment(newPayment);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(newPayment);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("completes a partially refunded payment with a second refund", async () => {
    const created = await client.createPayment(newPayment);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(newPayment);

    await expectApiError(badKeyClient.refundPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment(newPayment);
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...newPayment, source: "tok_pending" });

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...newPayment, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test.each([
    ["exceeds the payment amount", 1001],
    ["is zero", 0],
    ["is negative", -1],
    ["is not an integer", 10.5],
  ])("rejects a refund amount that %s with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(newPayment);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a refund larger than the remaining balance with 422", async () => {
    const created = await client.createPayment(newPayment);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...newPayment, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment({ ...newPayment, source: "tok_pending" });

    await expectApiError(badKeyClient.cancelPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(newPayment);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...newPayment, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});

describe("request handling", () => {
  test("sends the bearer token and JSON content type", async () => {
    let headers: Headers | undefined;
    server.use(
      http.post(`${BASE_URL}/payments`, ({ request }) => {
        headers = request.headers;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await client.createPayment(newPayment);

    expect(headers?.get("Authorization")).toBe("Bearer test_key");
    expect(headers?.get("Content-Type")).toBe("application/json");
  });

  test("falls back to unknown_error when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });

  test("uses a custom baseUrl when provided", async () => {
    server.use(
      http.get("https://staging.example.com/payments", () => HttpResponse.json({ data: [] })),
    );
    const staging = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://staging.example.com",
    });

    expect(await staging.listPayments()).toEqual([]);
  });
});
