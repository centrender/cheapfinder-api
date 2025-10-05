// Mocked search for demo
export async function searchCheapest({ q, zip, limit, minRating, minReviews, maxPrice, sources }) {
  const sample = [
    { source: 'Etsy', title: `${q} Alpha`, seller: 'Shop 111', rating: 4.7, reviews: 120, variant: 'Default', price: 19.99, shipping: 4.99, estimated_tax: 0, landed_price: 24.98, eta_days: 3, quality_score: 0.8, value_score: 13.87, listing_url: 'https://etsy.com/listing/1' },
    { source: 'Shopify (Aggregator)', title: `${q} Beta`, seller: 'Brand X', rating: 4.6, reviews: 803, variant: 'Default', price: 27, shipping: 9, estimated_tax: 0, landed_price: 36, eta_days: 5, quality_score: 0.7, value_score: 21.17, listing_url: 'https://brandx.com/products/beta' }
  ]
  const filtered = Number(maxPrice)>0 ? sample.filter(x => x.landed_price <= Number(maxPrice)) : sample
  return filtered.slice(0, limit)
}
