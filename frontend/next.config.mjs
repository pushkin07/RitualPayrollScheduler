/** @type {import('next').NextConfig} */
const isGithubPages = process.env.GITHUB_PAGES === "true";
const githubPagesBasePath = "/RitualPayrollScheduler";

const nextConfig = {
  output: "export",
  basePath: isGithubPages ? githubPagesBasePath : "",
  assetPrefix: isGithubPages ? `${githubPagesBasePath}/` : "",
  images: {
    unoptimized: true
  },
  typedRoutes: true,
  devIndicators: false,
  experimental: {
    devtoolSegmentExplorer: false
  }
};

export default nextConfig;
