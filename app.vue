<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="topbar-inner">
        <NuxtLink class="brand" to="/">AI Trading Assistant</NuxtLink>
        <nav class="nav">
          <NuxtLink to="/">XAUUSD</NuxtLink>
          <NuxtLink to="/eurusd">EURUSD</NuxtLink>
          <NuxtLink to="/history">Lich su</NuxtLink>
          <NuxtLink to="/stats">Thong ke</NuxtLink>
        </nav>
      </div>
    </header>
    <NuxtPage />
  </div>
</template>
