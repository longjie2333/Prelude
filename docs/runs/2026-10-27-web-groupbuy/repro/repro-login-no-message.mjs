// f-006: a failed login shows no feedback to the user.
// The backend answers {"code":401,"message":"账号或密码错误"}, but the login page's catch block
// swallows the error and renders no message, so the user cannot tell why login failed.
// Expected: an error message (e.g. "账号或密码错误") is shown and the user stays on the login page.
// Exit 1 if no visible feedback appears.
import { chromium } from "playwright";

const BASE = process.env.TARGET ?? "http://8.155.17.234:50080";
let reproduced = false;
const browser = await chromium.launch({ headless: true });
try {
	const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
	const loginResponses = [];
	page.on("response", async (r) => { if (r.url().includes("/auth/login")) loginResponses.push({ status: r.status(), body: await r.text().catch(() => "") }); });

	await page.goto(BASE + "/#/login", { waitUntil: "networkidle" });
	await page.fill('input[placeholder="请输入账号"]', "admin");
	await page.fill('input[placeholder="请输入密码"]', "definitely-wrong-password");
	await page.getByRole("button", { name: /登\s*录/ }).click();
	await page.waitForTimeout(2500);

	const visible = await page.evaluate(() => ({
		messages: [...document.querySelectorAll(".el-message, .el-message__content, .el-notification, .el-alert")].map((e) => e.textContent.trim()).filter(Boolean),
		formErrors: [...document.querySelectorAll(".el-form-item__error")].map((e) => e.textContent.trim()).filter(Boolean),
		inlineErrors: [...document.querySelectorAll(".error, .login-error, .tip-error")].map((e) => e.textContent.trim()).filter(Boolean),
		stillOnLogin: location.hash.includes("/login"),
	}));
	console.log("backend:", JSON.stringify(loginResponses));
	console.log("visible feedback:", JSON.stringify(visible));

	const feedback = [...visible.messages, ...visible.formErrors, ...visible.inlineErrors];
	if (loginResponses.some((r) => r.body.includes("账号或密码错误")) && feedback.length === 0 && visible.stillOnLogin) {
		console.log("\nPROBLEM REPRODUCED: login rejected (401) but no message/error is shown to the user.");
		reproduced = true;
	} else if (feedback.length) {
		console.log("\nfeedback shown:", feedback.join(" | "));
	}
} catch (e) {
	console.log("could not run:", e.message);
} finally {
	await browser.close();
}
process.exit(reproduced ? 1 : 0);