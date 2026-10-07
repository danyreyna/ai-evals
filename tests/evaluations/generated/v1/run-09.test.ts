import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsClient } from "./index.ts";
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

const newClient = () => new PaymentsClient({ apiKey: "test_key" });
const validInput = { amount: 5000, currency: "usd", source: "tok_visa" };

describe("PaymentsClient happy path", () => {
  test("createPayment creates a succeeded payment", async () => {
    const payment = await newClient().createPayment(validInput);

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 5000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("createPayment creates a pending payment for a pending source", async () => {
    const payment = await newClient().createPayment({ ...validInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });

  test("getPayment retrieves a created payment", async () => {
    const client = newClient();
    const created = await client.createPayment(validInput);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("listPayments returns all payments", async () => {
    const client = newClient();
    const first = await client.createPayment(validInput);
    const second = await client.createPayment({ ...validInput, amount: 1200 });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("listPayments returns an empty array when there are no payments", async () => {
    expect(await newClient().listPayments()).toEqual([]);
  });

  test("listPayments filters by status", async () => {
    const client = newClient();
    await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payments = await client.listPayments({ status: "pending" });

    expect(payments).toHaveLength(1);
    expect(payments[0]?.id).toBe(pending.id);
  });

  test("refundPayment fully refunds when no amount is given", async () => {
    const client = newClient();
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(5000);
  });

  test("refundPayment partially refunds when an amount is given", async () => {
    const client = newClient();
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 2000 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(2000);
  });

  test("refundPayment can refund the remainder after a partial refund", async () => {
    const client = newClient();
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 2000 });

    const refunded = await client.refundPayment(created.id, { amount: 3000 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(5000);
  });

  test("cancelPayment cancels a pending payment", async () => {
    const client = newClient();
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.status).toBe("canceled");
    expect(canceled.id).toBe(created.id);
  });

  test("uses a custom baseUrl when provided", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.get("https://custom.example.com/payments", () => HttpResponse.json({ data: [] })),
    );
    const client = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://custom.example.com",
    });

    expect(await client.listPayments()).toEqual([]);
  });
});
