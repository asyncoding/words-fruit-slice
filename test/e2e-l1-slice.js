(async () => {
  const canvas = document.querySelector("#gameCanvas") || document.querySelector("canvas");
  const rect = canvas.getBoundingClientRect();
  const sliceOne = (f) => {
    const fx = f.x * rect.width / canvas.width;
    const fy = f.y * rect.height / canvas.height;
    canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: fx - 12, clientY: fy, bubbles: true }));
    for (let i = 1; i <= 5; i++) canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: fx - 12 + 5 * i, clientY: fy + (i % 2) * 3, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent("mouseup", { clientX: fx + 12, clientY: fy, bubbles: true }));
  };
  const t0 = Date.now();
  let sliced = 0;
  while (Date.now() - t0 < 120000) {
    const dl = document.getElementById("dialog-overlay");
    if (dl && dl.style.display === "flex") return JSON.stringify({ ok: true, ms: Date.now() - t0, sliced, fruitsTarget: window.fruitsTarget, collected: state.collectedChars.length });
    if (typeof fruits !== "undefined") {
      const f = fruits.find(x => !x.sliced);
      if (f) { sliceOne(f); sliced++; }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return JSON.stringify({ ok: false, sliced, fruitsTarget: window.fruitsTarget });
})()
