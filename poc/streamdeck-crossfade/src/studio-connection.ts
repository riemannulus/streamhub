export function studioConnectionMessage(error: unknown): string {
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return 'Studio 서버와 연결이 끊겼습니다. 터미널에서 bun run studio를 실행하면 자동으로 다시 연결합니다.';
  }
  return error instanceof Error ? error.message : String(error);
}
