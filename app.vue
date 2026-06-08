<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="topbar-inner">
        <NuxtLink class="brand" to="/">AI Trading Assistant</NuxtLink>
        <nav class="nav">
          <NuxtLink to="/">Dashboard</NuxtLink>
          <NuxtLink to="/history">History</NuxtLink>
        </nav>
      </div>
    </header>
    <NuxtPage />
  </div>
</template>
