import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

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
): Promise<PaymentsApiError> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected PaymentsApiError ${status} ${code}, but the call resolved`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  return apiError;
}

describe("createPayment", () => {
  test("creates a succeeded payment that echoes the input", async () => {
    const payment = await client.createPayment(validInput);

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("gives each payment a unique id", async () => {
    const a = await client.createPayment(validInput);
    const b = await client.createPayment(validInput);

    expect(a.id).not.toBe(b.id);
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await client.createPayment(validInput);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const error = await expectApiError(badKeyClient.createPayment(validInput), 401, "unauthorized");

    expect(error.message).toBe("Missing or invalid API key");
  });

  test.each([
    ["zero amount", { ...validInput, amount: 0 }],
    ["negative amount", { ...validInput, amount: -5 }],
    ["fractional amount", { ...validInput, amount: 10.5 }],
    ["non-numeric amount", { ...validInput, amount: "1000" as unknown as number }],
    ["missing currency", { ...validInput, currency: undefined as unknown as string }],
    ["missing source", { ...validInput, source: undefined as unknown as string }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    const error = await expectApiError(
      client.createPayment({ ...validInput, source: "tok_unknown" }),
      400,
      "invalid_source",
    );

    expect(error.message).toBe("Unknown payment source");
  });

  test("surfaces a declined card as 402 card_declined", async () => {
    const error = await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(error.message).toBe("The card was declined");
  });

  test("surfaces insufficient funds as 402 insufficient_funds", async () => {
    const error = await expectApiError(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );

    expect(error.message).toBe("The card has insufficient funds");
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    const error = await expectApiError(
      client.createPayment({ ...validInput, source: "tok_serverError" }),
      500,
      "processing_error",
    );

    expect(error.message).toBe("An error occurred while processing the payment");
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment matching the id", async () => {
    const created = await client.createPayment({ ...validInput, amount: 2500 });
    await client.createPayment(validInput);

    const fetched = await client.getPayment(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.amount).toBe(2500);
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");

    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("url-encodes the id so path characters do not change the route", async () => {
    const error = await expectApiError(client.getPayment("a/b"), 404, "payment_not_found");

    expect(error.message).toBe("No payment with id a/b");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(badKeyClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(validInput);
    const b = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const onlyPending = await client.listPayments({ status: "pending" });
    const onlySucceeded = await client.listPayments({ status: "succeeded" });

    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(validInput);

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("reflects status changes in the filter", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(payment.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    const canceled = await client.listPayments({ status: "canceled" });
    expect(canceled.map((p) => p.id)).toEqual([payment.id]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const payment = await client.createPayment(validInput);

    const refunded = await client.refundPayment(payment.id);

    expect(refunded.id).toBe(payment.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds when an amount is given", async () => {
    const payment = await client.createPayment(validInput);

    const refunded = await client.refundPayment(payment.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("accumulates partial refunds and ends as refunded", async () => {
    const payment = await client.createPayment(validInput);

    await client.refundPayment(payment.id, { amount: 400 });
    const second = await client.refundPayment(payment.id, { amount: 600 });

    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("refunds only the remainder when no amount follows a partial refund", async () => {
    const payment = await client.createPayment(validInput);
    await client.refundPayment(payment.id, { amount: 300 });

    const refunded = await client.refundPayment(payment.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund on the stored payment", async () => {
    const payment = await client.createPayment(validInput);
    await client.refundPayment(payment.id, { amount: 250 });

    const fetched = await client.getPayment(payment.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("returns 409 already_refunded for a fully refunded payment", async () => {
    const payment = await client.createPayment(validInput);
    await client.refundPayment(payment.id);

    const error = await expectApiError(
      client.refundPayment(payment.id),
      409,
      "already_refunded",
    );

    expect(error.message).toBe("Payment already refunded");
  });

  test("returns 409 not_refundable for a pending payment", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    const error = await expectApiError(client.refundPayment(payment.id), 409, "not_refundable");

    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("returns 409 not_refundable for a canceled payment", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(payment.id);

    await expectApiError(client.refundPayment(payment.id), 409, "not_refundable");
  });

  test("returns 422 invalid_refund_amount when the amount exceeds the payment", async () => {
    const payment = await client.createPayment(validInput);

    const error = await expectApiError(
      client.refundPayment(payment.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );

    expect(error.message).toBe("Refund amount must be between 1 and 1000");
  });

  test("returns 422 invalid_refund_amount when the amount exceeds the remainder", async () => {
    const payment = await client.createPayment(validInput);
    await client.refundPayment(payment.id, { amount: 700 });

    const error = await expectApiError(
      client.refundPayment(payment.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
    );

    expect(error.message).toBe("Refund amount must be between 1 and 300");
  });

  test.each([
    ["zero", 0],
    ["negative", -10],
    ["fractional", 10.5],
  ])("returns 422 invalid_refund_amount for a %s amount", async (_name, amount) => {
    const payment = await client.createPayment(validInput);

    await expectApiError(client.refundPayment(payment.id, { amount }), 422, "invalid_refund_amount");
  });

  test("does not change the payment when a refund is rejected", async () => {
    const payment = await client.createPayment(validInput);
    await expectApiError(
      client.refundPayment(payment.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    const fetched = await client.getPayment(payment.id);

    expect(fetched.status).toBe("succeeded");
    expect(fetched.amountRefunded).toBe(0);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const payment = await client.createPayment(validInput);

    await expectApiError(badKeyClient.refundPayment(payment.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(payment.id);

    expect(canceled.id).toBe(payment.id);
    expect(canceled.status).toBe("canceled");
  });

  test("persists the cancellation on the stored payment", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(payment.id);

    expect((await client.getPayment(payment.id)).status).toBe("canceled");
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("returns 409 not_cancelable for a succeeded payment", async () => {
    const payment = await client.createPayment(validInput);

    const error = await expectApiError(client.cancelPayment(payment.id), 409, "not_cancelable");

    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("returns 409 not_cancelable for an already canceled payment", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(payment.id);

    const error = await expectApiError(client.cancelPayment(payment.id), 409, "not_cancelable");

    expect(error.message).toBe("A canceled payment cannot be canceled");
  });

  test("returns 409 not_cancelable for a refunded payment", async () => {
    const payment = await client.createPayment(validInput);
    await client.refundPayment(payment.id);

    await expectApiError(client.cancelPayment(payment.id), 409, "not_cancelable");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(badKeyClient.cancelPayment(payment.id), 401, "unauthorized");
  });
});

describe("request wiring", () => {
  test("sends the bearer token and JSON body on create", async () => {
    let seen: { auth: string | null; contentType: string | null; body: unknown } | undefined;
    server.use(
      http.post(`${BASE_URL}/payments`, async ({ request }) => {
        seen = {
          auth: request.headers.get("Authorization"),
          contentType: request.headers.get("Content-Type"),
          body: await request.json(),
        };
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await client.createPayment(validInput);

    expect(seen).toEqual({
      auth: "Bearer test_key",
      contentType: "application/json",
      body: validInput,
    });
  });

  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://custom.example.com/api/payments/pay_1", () =>
        HttpResponse.json({ id: "pay_1" }),
      ),
    );
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://custom.example.com/api",
    });

    expect(await custom.getPayment("pay_1")).toEqual({ id: "pay_1" } as never);
  });

  test("falls back to unknown_error and the status text for a non-JSON error body", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/pay_1`,
        () => new HttpResponse("upstream down", { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    const error = await expectApiError(client.getPayment("pay_1"), 503, "unknown_error");

    expect(error.message).toBe("Service Unavailable");
  });
});
