const form = document.querySelector("#login-form");
const email = document.querySelector("#email");
const password = document.querySelector("#password");
const errorBox = document.querySelector("#login-error");
const submit = document.querySelector("#login-submit");

function nextUrl() {
  const raw = new URLSearchParams(location.search).get("next") || "/";
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() { errorBox.hidden = true; }

async function alreadySignedIn() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.user) { location.replace(nextUrl()); return true; }
  } catch { /* offline login still possible? no, fall through */ }
  return false;
}

form.addEventListener("submit", async e => {
  e.preventDefault();
  clearError();
  const em = email.value.trim();
  const pw = password.value;
  if (!em || !pw) { showError("请填写邮箱和密码。"); return; }
  submit.disabled = true;
  submit.textContent = "正在验证…";
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: em, password: pw })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error?.message || "登录失败，请检查邮箱与密码。");
      submit.disabled = false;
      submit.textContent = "登录";
      return;
    }
    location.replace(nextUrl());
  } catch (err) {
    showError("无法连接服务端：" + (err.message || err));
    submit.disabled = false;
    submit.textContent = "登录";
  }
});

document.querySelectorAll("[data-demo]").forEach(btn => {
  btn.addEventListener("click", () => {
    email.value = btn.dataset.demo;
    password.value = btn.dataset.pass;
    clearError();
    password.focus();
  });
});

document.querySelector("#toggle-password").addEventListener("click", () => {
  const isPassword = password.type === "password";
  password.type = isPassword ? "text" : "password";
  document.querySelector("#toggle-password").textContent = isPassword ? "隐藏" : "显示";
});

if (!(await alreadySignedIn())) {
  email.focus();
}
