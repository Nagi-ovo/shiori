import { describe, expect, test } from "bun:test";

const TAO_ANDROID_SOURCE =
  "src-tauri/patches/tao-0.35.3/src/platform_impl/android/mod.rs";
const WRY_ANDROID_SOURCE =
  "src-tauri/patches/wry-0.55.1/src/android/main_pipe.rs";

describe("vendored Android event delivery backports", () => {
  // The source checks below prove the fix is in the vendored copy; this one
  // proves the build still uses that copy. After a tao/wry bump the
  // [patch.crates-io] entry silently stops applying and Cargo.lock resolves
  // the crate from crates.io again, while every source check stays green.
  test.each([
    ["tao", "0.35.3"],
    ["wry", "0.55.1"],
  ])("the build resolves %s to the vendored %s patch", async (name, version) => {
    const lock = await Bun.file("src-tauri/Cargo.lock").text();
    const packages = lock
      .split("[[package]]")
      .filter((block) => block.includes(`\nname = "${name}"\n`));
    expect(packages).toHaveLength(1);
    expect(packages[0]).toContain(`\nversion = "${version}"\n`);
    expect(packages[0]).not.toContain("\nsource = ");
  });

  test("carries Tao's upstream publish-before-wake implementation", async () => {
    const source = await Bun.file(TAO_ANDROID_SOURCE).text();
    const body = source.match(
      /impl<T> EventLoopProxy<T> \{[\s\S]*?pub fn send_event[\s\S]*?\{([\s\S]*?)\n {2}\}\n\}/,
    )?.[1];

    expect(body).toBeDefined();
    expect(body).toContain("let _ = self.queue.send(event);");
    expect(body).not.toContain("try_send(event)");
    expect(body!.indexOf("queue.send(event)")).toBeLessThan(
      body!.indexOf("looper.wake()"),
    );
  });

  test("drains Tao user events even when Android reports another poll source", async () => {
    const source = await Bun.file(TAO_ANDROID_SOURCE).text();
    const pollDispatchStart = source.indexOf("match self.first_event.take()");
    const pollDispatchEnd = source.indexOf(
      "        None => {}\n      }",
      pollDispatchStart,
    );
    const mainEventsCleared = source.indexOf(
      "event::Event::MainEventsCleared",
      pollDispatchEnd,
    );
    const unconditionalDrain = source.indexOf(
      "while let Ok(event) = self.receiver.try_recv()",
      pollDispatchEnd,
    );

    expect(pollDispatchStart).toBeGreaterThanOrEqual(0);
    expect(pollDispatchEnd).toBeGreaterThan(pollDispatchStart);
    expect(mainEventsCleared).toBeGreaterThan(pollDispatchEnd);
    expect(unconditionalDrain).toBeGreaterThan(pollDispatchEnd);
    expect(unconditionalDrain).toBeLessThan(mainEventsCleared);
    expect(source.slice(unconditionalDrain, mainEventsCleared)).toContain(
      "event::Event::UserEvent(event)",
    );
  });

  test("drains every queued Wry main-pipe message after one wake", async () => {
    const source = await Bun.file(WRY_ANDROID_SOURCE).text();
    const body = source.match(
      /pub fn recv\(&mut self\)[\s\S]*?\{([\s\S]*?)\n {2}\}\n\}/,
    )?.[1];

    expect(body).toBeDefined();
    expect(body).toContain("while let Ok((activity_id, message))");
    expect(body).toContain("CHANNEL.1.try_recv()");
    expect(body).not.toContain("CHANNEL.1.recv()");
    expect(body).toMatch(
      /eprintln!\("no activity found[\s\S]*?continue;/,
    );
  });
});
