// One query interface, two Postgres engines:
// Neon over HTTP in production (DATABASE_URL), PGlite on disk or in memory locally and in tests.
export async function openDatabase({ url = '', dataDir = null } = {}) {
  if (url) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    return {
      query: (text, params = []) => sql.query(text, params),
      close: async () => {},
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return {
    query: async (text, params = []) => (await pg.query(text, params)).rows,
    close: () => pg.close(),
  };
}
