<template>
  <main class="page dashboard-page">
    <div class="heading dashboard-heading">
      <p class="eyebrow">AI Trading Assistant</p>
      <h1>Chọn thị trường cần phân tích</h1>
      <p>
        Mỗi thị trường có luồng phân tích, lịch sử và thống kê riêng. Hệ thống
        chỉ đưa gợi ý giao dịch thủ công, không tự đặt lệnh.
      </p>
    </div>

    <section class="market-grid">
      <NuxtLink class="market-card gold-card" to="/xauusd">
        <span class="market-code">XAUUSD</span>
        <h2>Vàng / Đô la Mỹ</h2>
        <p>Twelve Data, GNews và phân tích đa khung thời gian.</p>
        <strong>Mở XAUUSD →</strong>
      </NuxtLink>

      <NuxtLink class="market-card btc-card" to="/btc">
        <span class="market-code">BTCUSD</span>
        <h2>Bitcoin / Đô la Mỹ</h2>
        <p>Binance Spot, CryptoPanic và dữ liệu thị trường 24/7.</p>
        <strong>Mở BTC →</strong>
      </NuxtLink>
    </section>
  </main>
</template>

<style scoped>
.dashboard-page {
  padding-top: 64px;
}
.dashboard-heading {
  max-width: 720px;
}
.eyebrow {
  color: #7cc4ff;
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}
.market-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 28px;
}
.market-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: inherit;
  display: grid;
  gap: 12px;
  min-height: 210px;
  padding: 24px;
  text-decoration: none;
  transition: border-color 160ms ease, transform 160ms ease;
}
.market-card:hover {
  border-color: #4f9fe3;
  transform: translateY(-2px);
}
.market-card h2,
.market-card p {
  margin: 0;
}
.market-card p {
  color: var(--muted);
}
.market-card strong {
  align-self: end;
}
.market-code {
  font-size: 13px;
  font-weight: 900;
}
.gold-card .market-code {
  color: #f5c96a;
}
.btc-card .market-code {
  color: #f7931a;
}
@media (max-width: 700px) {
  .dashboard-page {
    padding-top: 32px;
  }
  .market-grid {
    grid-template-columns: 1fr;
  }
}
</style>
