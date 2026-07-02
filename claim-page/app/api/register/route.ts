import { EU_COUNTRIES, QueryResult, ZKPassport } from "@zkpassport/sdk";

import { ProofResult } from "@zkpassport/sdk";

export const config = {
  runtime: "edge",
};

export async function POST(request: Request) {
  const {
    queryResult,
    proofs,
    domain,
  }: {
    queryResult: QueryResult;
    proofs: ProofResult[];
    domain: string;
  } = await request.json();

  const zkpassport = new ZKPassport(domain);

  // Recreate the query to enforce the right conditions were checked by the app
  const { query } = await zkpassport
    .createQuery()
    .in("nationality", [...EU_COUNTRIES, "Zero Knowledge Republic"])
    .disclose("firstname")
    .gte("age", 18)
    .disclose("document_type")
    .facematch("strict")
    .sanctions()
    .gte("age", 18)
    .done();

  const { verified, uniqueIdentifier } = await zkpassport.verify({
    proofs,
    originalQuery: query,
    queryResult,
    devMode: true,
  });

  console.log("Verified", verified);
  console.log("Unique identifier", uniqueIdentifier);

  // Do something with it, such as using the unique identifier to
  // identify the user in the database

  return Response.json({ registered: verified });
}
