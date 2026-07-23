import { NextResponse } from 'next/server';

/**
 * Temporary audit endpoint intentionally disabled after the controlled test.
 * Keep it non-operational until the file is removed in the cleanup gate.
 */
export async function POST() {
  return NextResponse.json({ error: 'Não encontrado' }, { status: 404 });
}
