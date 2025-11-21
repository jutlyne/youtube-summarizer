/**
 * Hàm tạo độ trễ (delay)
 * @param {number} ms Số mili giây cần chờ.
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
