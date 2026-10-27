// f-007: cancelling the delete confirmation on 商品管理 raises an uncaught promise rejection.
// Element Plus MessageBox rejects with "cancel" when the user dismisses it; the page does not
// catch it, so the browser console logs an error. Expected: no console error on cancel.
// Exit 1 if a console/page error appears while cancelling.
import { chromium } from "playwright";

const BASE = process.env.TARGET ?? "http://8.155.17.234:50080";
let reproduced = false;
const browser = await chromium.launch({ headless: true });
try {
	const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
	const errors = [];
	page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });
	page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 200)));

	await page.goto(BASE + "/#/login", { waitUntil: "networkidle" });
	await page.fill('input[placeholder="请输入账号"]', "admin");
	await page.fill('input[placeholder="请输入密码"]', "<redacted>");
	await page.getByRole("button", { name: /登\s*录/ }).click();
	await page.waitForTimeout(1700);

	await page.goto(BASE + "/#/admin/products", { waitUntil: "networkidle" });
	await page.waitForTimeout(900);
	const rowsBefore = await page.locator(".el-table__row").count();
	await page.locator(".el-table__row").first().getByRole("button", { name: "删除" }).click();
	await page.waitForTimeout(600);
	await page.getByRole("button", { name: "取消" }).click();
	await page.waitForTimeout(1500);

	const rowsAfter = await page.locator(".el-table__row").count();
	console.log("console errors on cancel:", JSON.stringify(errors));
	console.log(`rows before=${rowsBefore} after=${rowsAfter} (data must be unchanged)`);
	if (errors.length) {
		console.log("\nPROBLEM REPRODUCED: dismissing the delete confirmation logs an uncaught error.");
		reproduced = true;
	}
} catch (e) {
	console.log("could not run:", e.message);
} finally {
	await browser.close();
}
process.exit(reproduced ? 1 : 0);