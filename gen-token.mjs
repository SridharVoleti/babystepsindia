import { SignJWT } from "jose";

const secret = new TextEncoder().encode(
  "31ab87b5793825f19b7412fc8b72568ea5151d5bbd1713f543fb325827694a88",
);

const token = await new SignJWT({
  sub: "d8582dc5-1703-4fed-84c2-a26c026ed79c",
  email: "parent@example.com",
  isAdmin: false,
  entitlements: { bundle: false, products: ["chess", "magical-math"] },
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
  .sign(secret);

console.log(token);
