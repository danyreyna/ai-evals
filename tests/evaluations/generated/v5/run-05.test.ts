import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
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

async function catchError(promise: Promise<unknown>): Promise<PaymentsApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentsApiError);
    return error as PaymentsApiError;
  }
  throw new Error("Expected the call to reject with PaymentsApiError");
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await catchError(promise);
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
  return error;
}

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("creates a succeeded payment with the submitted fields", async () => {
    const payment = await newPayment("tok_visa", 2500);

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await newPayment("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("sends the bearer token and a JSON body", async () => {
    let authorization: string | null = null;
    let contentType: string | null = null;
    let body: unknown;
    server.use(
      http.post(`${BASE_URL}/payments`, async ({ request }) => {
        authorization = request.headers.get("Authorization");
        contentType = request.headers.get("Content-Type");
        body = await request.json();
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await newPayment("tok_visa", 700);

    expect(authorization).toBe("Bearer test_key");
    expect(contentType).toBe("application/json");
    expect(body).toEqual({ amount: 700, currency: "usd", source: "tok_visa" });
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const error = await expectApiError(newPayment("tok_chargeDeclined"), 402, "card_declined");
    expect(error.message).toBe("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    const error = await expectApiError(
      newPayment("tok_insufficientFunds"),
      402,
      "insufficient_funds",
    );
    expect(error.message).toBe("The card has insufficient funds");
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    const error = await expectApiError(newPayment("tok_serverError"), 500, "processing_error");
    expect(error.message).toBe("An error occurred while processing the payment");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(newPayment("tok_nope"), 400, "invalid_source");
  });

  test.each([
    ["zero amount", 0],
    ["negative amount", -5],
    ["fractional amount", 10.5],
  ])("rejects a %s with 400 invalid_request", async (_label, amount) => {
    await expectApiError(newPayment("tok_visa", amount), 400, "invalid_request");
  });

  test("does not store a payment that failed", async () => {
    await catchError(newPayment("tok_chargeDeclined"));
    expect(await client.listPayments()).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong" });
    const error = await expectApiError(
      bad.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
    expect(error.message).toBe("Missing or invalid API key");
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await newPayment("tok_visa", 1234);
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("url-encodes the id", async () => {
    let pathname = "";
    server.use(
      http.get(`${BASE_URL}/payments/:id`, ({ request }) => {
        pathname = new URL(request.url).pathname;
        return HttpResponse.json({});
      }),
    );

    await client.getPayment("a/b c");

    expect(pathname).toBe("/v1/payments/a%2Fb%20c");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong" });
    await expectApiError(bad.getPayment("pay_any"), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment as a plain array", async () => {
    const a = await newPayment("tok_visa");
    const b = await newPayment("tok_pending");

    const payments = await client.listPayments();

    expect(Array.isArray(payments)).toBe(true);
    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await newPayment("tok_visa");
    const pending = await newPayment("tok_pending");

    const result = await client.listPayments({ status: "pending" });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(pending.id);
    expect(result[0]?.status).toBe("pending");
  });

  test("returns nothing when no payment matches the status", async () => {
    await newPayment("tok_visa");
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes after refund and cancel", async () => {
    const succeeded = await newPayment("tok_visa", 500);
    const pending = await newPayment("tok_pending");
    await client.refundPayment(succeeded.id);
    await client.cancelPayment(pending.id);

    const refunded = await client.listPayments({ status: "refunded" });
    const canceled = await client.listPayments({ status: "canceled" });

    expect(refunded.map((p) => p.id)).toEqual([succeeded.id]);
    expect(canceled.map((p) => p.id)).toEqual([pending.id]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong" });
    await expectApiError(bad.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.id).toBe(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds a given amount", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("rejects refunding twice with 409 already_refunded", async () => {
    const created = await newPayment("tok_visa");
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");

    const error = await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 600 });

    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 401 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 400");
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await newPayment("tok_visa", 1000);

    await expectApiError(client.refundPayment(created.id, { amount }), 422, "invalid_refund_amount");
  });

  test("does not change the payment when a refund is rejected", async () => {
    const created = await newPayment("tok_visa", 1000);
    await catchError(client.refundPayment(created.id, { amount: 5000 }));

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("succeeded");
    expect(fetched.amountRefunded).toBe(0);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong" });
    await expectApiError(bad.refundPayment("pay_any"), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("sends no JSON body", async () => {
    let contentType: string | null = "unset";
    server.use(
      http.post(`${BASE_URL}/payments/:id/cancel`, ({ request }) => {
        contentType = request.headers.get("Content-Type");
        return HttpResponse.json({});
      }),
    );

    await client.cancelPayment("pay_any");

    expect(contentType).toBeNull();
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_visa");

    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects canceling twice with 409 not_cancelable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong" });
    await expectApiError(bad.cancelPayment("pay_any"), 401, "unauthorized");
  });
});

describe("error parsing fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    const error = await expectApiError(client.getPayment("pay_any"), 502, "unknown_error");
    expect(error.message).toBe("Bad Gateway");
  });

  test("uses unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments`, () => HttpResponse.json({ oops: true }, { status: 503 })),
    );

    await expectApiError(client.listPayments(), 503, "unknown_error");
  });

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
