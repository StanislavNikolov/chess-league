import { makeTmpDir } from "./utils";

export async function compile(code: string) {
  // Copy the template project into a tmpdir.
  const tmpdir = makeTmpDir();
  const cp = Bun.spawn(["cp", "-r", "./bot-scaffold", tmpdir]);
  await cp.exited;

  // Fix common compilation errors.
  code = code.replaceAll(" Timer ", " ChessChallenge.API.Timer ");
  code = code.replaceAll(",Timer ", ",ChessChallenge.API.Timer ");

  // Save the code to be compiled.
  await Bun.write(`${tmpdir}/MyBot.cs`, code);

  // Run the compiler.
  // There seems to be a bug in bun, and using the default proc.stdout, which
  // is a readble stream, simply hangs. This is a workaround.
  const dotnet = Bun.spawn(["dotnet", "publish", "-c", "Release"], {
    cwd: tmpdir,
    stdout: Bun.file(`${tmpdir}/log.txt`),
  });
  await dotnet.exited;
  const stdout = await Bun.file(`${tmpdir}/log.txt`).text();

  console.log("Compilation done", dotnet.exitCode);

  if (dotnet.exitCode !== 0) {
    // Delete the tmpdir.
    const rm = Bun.spawn(["rm", "-rf", tmpdir]);
    await rm.exited;
    return { ok: false, msg: stdout };
  }

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(code);
  const hash = hasher.digest("base64url");

  await Bun.write(
    Bun.file(`compiled/${hash}.dll`),
    Bun.file(`${tmpdir}/bin/Release/net6.0/Chess-Challenge.dll`),
  );

  // Delete the tmpdir.
  const rm = Bun.spawn(["rm", "-rf", tmpdir]);
  await rm.exited;

  return { ok: true, msg: "", hash };
}
