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
    v-if="isCheckingAccess"
    class="grid min-h-screen place-items-center bg-[var(--bg)] px-5 text-[var(--text)]"
  >
    <div class="grid justify-items-center gap-4">
      <div
        class="h-10 w-10 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--blue)]"
      />
      <p class="text-sm font-semibold text-[var(--muted)]">
        Đang tải hệ thống...
      </p>
    </div>
  </div>

  <div
    v-else-if="!isUnlocked"
    class="grid min-h-screen place-items-center bg-[var(--bg)] px-5 text-[var(--text)]"
  >
    <form
      class="grid w-full max-w-[420px] gap-[18px] rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6"
      @submit.prevent="unlock"
    >
      <div>
        <h1 class="mb-2 text-2xl font-bold tracking-normal">
          AI XAUUSD Trading Assistant
        </h1>
        <p class="m-0 text-[var(--muted)]">
          Nhập mật khẩu để truy cập hệ thống.
        </p>
      </div>

      <label class="grid gap-2 font-bold">
        <span>Mật khẩu</span>
        <input
          v-model="password"
          class="input"
          type="password"
          autocomplete="current-password"
          autofocus
        >
      </label>

      <p v-if="errorMessage" class="m-0 font-bold text-[var(--red)]">
        {{ errorMessage }}
      </p>

      <button class="button w-full" type="submit">Vào hệ thống</button>
    </form>
  </div>

  <div v-else class="app-shell">
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
</template>
