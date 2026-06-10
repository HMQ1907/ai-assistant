<script setup lang="ts">
const accessPassword = "Nhung2803@";

const isUnlocked = ref(false);
const isCheckingAccess = ref(true);
const password = ref("");
const errorMessage = ref("");

onMounted(() => {
  isUnlocked.value = sessionStorage.getItem("xauusd-assistant-unlocked") === "1";
  isCheckingAccess.value = false;
});

function unlock() {
  if (password.value === accessPassword) {
    sessionStorage.setItem("xauusd-assistant-unlocked", "1");
    isUnlocked.value = true;
    password.value = "";
    errorMessage.value = "";
    return;
  }

  errorMessage.value = "Mật khẩu không đúng.";
}
</script>

<template>
  <div
    class="app-shell"
    :class="{ 'app-shell-locked': !isUnlocked }"
    :aria-hidden="!isUnlocked"
  >
    <header class="topbar">
      <div class="topbar-inner">
        <NuxtLink class="brand" to="/">AI XAUUSD Trading Assistant</NuxtLink>
        <nav class="nav">
          <NuxtLink to="/">Phân tích</NuxtLink>
          <NuxtLink to="/history">Lịch sử</NuxtLink>
          <NuxtLink to="/stats">Thống kê</NuxtLink>
        </nav>
      </div>
    </header>
    <NuxtPage />
  </div>

  <div v-if="isCheckingAccess || !isUnlocked" class="access-screen">
    <div v-if="isCheckingAccess" class="loading-box">
      <div class="loading-ring" />
      <p>Đang tải hệ thống...</p>
    </div>

    <form v-else class="access-card" @submit.prevent="unlock">
      <div class="access-mark">X</div>

      <div class="access-copy">
        <p class="access-eyebrow">Quyền truy cập riêng</p>
        <h1>AI XAUUSD Trading Assistant</h1>
        <p>
          Nhập mật khẩu để mở công cụ phân tích XAUUSD. Hệ thống chỉ hiển thị
          gợi ý giao dịch thủ công, không tự đặt lệnh.
        </p>
      </div>

      <label class="access-field">
        <span>Mật khẩu</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="Nhập mật khẩu truy cập"
          autofocus
        >
      </label>

      <p v-if="errorMessage" class="access-error">
        {{ errorMessage }}
      </p>

      <button class="access-submit" type="submit">Vào hệ thống</button>

      <p class="access-note">
        Dữ liệu phân tích phục vụ quyết định thủ công. Người dùng tự chịu trách
        nhiệm với lệnh giao dịch của mình.
      </p>
    </form>
  </div>
</template>

<style scoped>
.access-screen {
  align-items: center;
  background:
    radial-gradient(circle at 50% 0%, rgba(50, 107, 156, 0.24), transparent 34%),
    linear-gradient(180deg, #0f1720 0%, #090e13 100%);
  box-sizing: border-box;
  color: var(--text);
  display: flex;
  justify-content: center;
  inset: 0;
  min-height: 100vh;
  overflow: hidden;
  padding: 24px;
  position: fixed;
  width: 100%;
  z-index: 1000;
}

.app-shell-locked {
  height: 100vh;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
}

.access-screen::before {
  background:
    linear-gradient(rgba(124, 196, 255, 0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(124, 196, 255, 0.04) 1px, transparent 1px);
  background-size: 44px 44px;
  content: "";
  inset: 0;
  mask-image: radial-gradient(circle at center, black, transparent 72%);
  pointer-events: none;
  position: absolute;
}

.access-card {
  background: rgba(17, 25, 34, 0.96);
  border: 1px solid #2a4057;
  border-radius: 18px;
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.46);
  box-sizing: border-box;
  display: grid;
  gap: 20px;
  max-width: 460px;
  padding: 30px;
  position: relative;
  width: min(100%, 460px);
  z-index: 1;
}

.access-card::after {
  background: linear-gradient(90deg, #2a6fb8, #55c7a6);
  border-radius: 18px 18px 0 0;
  content: "";
  height: 3px;
  inset: 0 0 auto;
  position: absolute;
}

.access-mark {
  align-items: center;
  background: #162436;
  border: 1px solid #31506d;
  border-radius: 14px;
  color: #7cc4ff;
  display: flex;
  font-size: 20px;
  font-weight: 900;
  height: 52px;
  justify-content: center;
  width: 52px;
}

.access-copy {
  display: grid;
  gap: 10px;
}

.access-eyebrow {
  color: #7cc4ff;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.14em;
  margin: 0;
  text-transform: uppercase;
}

.access-copy h1 {
  font-size: 30px;
  line-height: 1.12;
  margin: 0;
}

.access-copy p:not(.access-eyebrow),
.access-note,
.loading-box p {
  color: var(--muted);
  line-height: 1.55;
  margin: 0;
}

.access-field {
  display: grid;
  gap: 8px;
}

.access-field span {
  color: #c9d8e8;
  font-size: 14px;
  font-weight: 800;
}

.access-field input {
  background: #17212b;
  border: 1px solid #30465c;
  border-radius: 10px;
  box-sizing: border-box;
  color: var(--text);
  font: inherit;
  height: 48px;
  outline: none;
  padding: 0 14px;
  width: 100%;
}

.access-field input:focus {
  border-color: #4f9fe3;
  box-shadow: 0 0 0 3px rgba(79, 159, 227, 0.16);
}

.access-error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.32);
  border-radius: 10px;
  color: var(--red);
  font-weight: 800;
  margin: 0;
  padding: 10px 12px;
}

.access-submit {
  background: linear-gradient(135deg, #2d73bd, #2364a8);
  border: 1px solid #4387ce;
  border-radius: 10px;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-weight: 900;
  height: 48px;
  width: 100%;
}

.access-submit:hover {
  filter: brightness(1.08);
}

.access-note {
  font-size: 12px;
  text-align: center;
}

.loading-box {
  display: grid;
  gap: 14px;
  justify-items: center;
  z-index: 1;
}

.loading-ring {
  animation: spin 0.8s linear infinite;
  border: 2px solid var(--border);
  border-radius: 999px;
  border-top-color: var(--blue);
  height: 42px;
  width: 42px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 560px) {
  .access-screen {
    align-items: stretch;
    padding: 16px;
  }

  .access-card {
    align-self: center;
    border-radius: 16px;
    padding: 24px;
  }

  .access-copy h1 {
    font-size: 25px;
  }
}
</style>
