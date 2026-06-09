<script setup lang="ts">
const accessPassword = "Nhung2803@";

const isUnlocked = ref(false);
const password = ref("");
const errorMessage = ref("");

onMounted(() => {
  isUnlocked.value = sessionStorage.getItem("xauusd-assistant-unlocked") === "1";
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
  <div v-if="!isUnlocked" class="access-page">
    <form class="access-card" @submit.prevent="unlock">
      <div>
        <h1>AI XAUUSD Trading Assistant</h1>
        <p>Nhập mật khẩu để truy cập hệ thống.</p>
      </div>

      <label class="access-field">
        <span>Mật khẩu</span>
        <input
          v-model="password"
          class="input"
          type="password"
          autocomplete="current-password"
          autofocus
        >
      </label>

      <p v-if="errorMessage" class="access-error">{{ errorMessage }}</p>

      <button class="button access-button" type="submit">Vào hệ thống</button>
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
