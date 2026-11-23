// POST /api/chat: stub (TASKS.md M0-5). The real chat route lands in M1-7,
// behind the Model Gate. Until then every request gets an explicit 501.
// TECH_STACK.md Section 3.1: Hobby with Fluid compute allows up to 300 s.
// 60 s covers up to three short model calls and caps a stuck request.
// This route reads no environment variables.
export const maxDuration = 60;

export async function POST() {
  return Response.json({ error: "not implemented" }, { status: 501 });
}
