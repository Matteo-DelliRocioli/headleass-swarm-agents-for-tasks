import jwt from "jsonwebtoken";
import Stripe from "stripe";

// VULNERABILITY: Hardcoded JWT secret
const JWT_SECRET = "super-secret-jwt-key-12345-never-do-this";

// VULNERABILITY: Hardcoded API key
const stripe = new Stripe("sk_test_FAKE_KEY_FOR_EVAL_FIXTURE_DO_NOT_USE");

// VULNERABILITY: Database connection with embedded password
const DB_CONNECTION = "postgresql://admin:p@ssw0rd123@db.example.com:5432/production";

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): any {
  return jwt.verify(token, JWT_SECRET);
}

export async function chargeCustomer(customerId: string, amount: number) {
  return stripe.charges.create({
    amount,
    currency: "usd",
    customer: customerId,
  });
}

// VULNERABILITY: Logging sensitive data
export function debugAuth(token: string) {
  console.log(`Auth token received: ${token}`);
  const decoded = verifyToken(token);
  console.log(`Decoded payload: ${JSON.stringify(decoded)}`);
  return decoded;
}
