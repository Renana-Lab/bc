import { useEffect } from "react";
import { useLocation, useParams } from "react-router-dom";

const SITE_NAME = "Blockchain Data Market";
const DEFAULT_TITLE = "Blockchain Data Market | Web3 Research Data Auctions";
const DEFAULT_DESCRIPTION =
  "A Web3 research data auction platform where sellers open blockchain-backed data auctions and bidders participate through MetaMask on Ethereum Sepolia.";
const DEFAULT_IMAGE_PATH = "/logo512.png";

const PAGE_SEO = {
  home: {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    robots: "index,follow",
    type: "website",
  },
  metamaskLogin: {
    title: "Connect MetaMask | Blockchain Data Market",
    description:
      "Check your MetaMask connection before entering the Blockchain Data Market auction platform.",
    robots: "noindex,follow",
  },
  metamaskGuide: {
    title: "MetaMask Setup Guide | Blockchain Data Market",
    description:
      "Step-by-step MetaMask and Sepolia setup guidance for participating in blockchain research data auctions.",
    robots: "index,follow",
    type: "article",
  },
  createAuction: {
    title: "Create a Data Auction | Blockchain Data Market",
    description:
      "Open a new blockchain-backed research data auction in the selected market contract.",
    robots: "noindex,follow",
  },
  auctionsList: {
    title: "Live Data Auctions | Blockchain Data Market",
    description:
      "Browse active and closed research data auctions, compare bids, bidder counts, end dates, and payment status.",
    robots: "index,follow",
  },
  auctionDetails: {
    title: "Auction Details | Blockchain Data Market",
    description:
      "View a single blockchain data auction, including seller, bidding, budget, and payment state.",
    robots: "noindex,follow",
  },
  admin: {
    title: "Admin Zone | Blockchain Data Market",
    description:
      "Operational tools for contracts, budgets, automation health, batch auction creation, and reports.",
    robots: "noindex,nofollow",
  },
};

const ensureMeta = (selector, createElement, contentKey, contentValue) => {
  let element = document.head.querySelector(selector);
  if (!element) {
    element = createElement();
    document.head.appendChild(element);
  }
  element.setAttribute(contentKey, contentValue);
  return element;
};

const setNamedMeta = (name, content) =>
  ensureMeta(
    `meta[name="${name}"]`,
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("name", name);
      return meta;
    },
    "content",
    content
  );

const setPropertyMeta = (property, content) =>
  ensureMeta(
    `meta[property="${property}"]`,
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("property", property);
      return meta;
    },
    "content",
    content
  );

const setCanonical = (href) => {
  ensureMeta(
    'link[rel="canonical"]',
    () => {
      const link = document.createElement("link");
      link.setAttribute("rel", "canonical");
      return link;
    },
    "href",
    href
  );
};

const stripTrailingSlash = (value) => value.replace(/\/+$/, "");

const getSiteOrigin = () => {
  const configuredSiteUrl = stripTrailingSlash(
    process.env.REACT_APP_SITE_URL || ""
  );

  if (configuredSiteUrl) return configuredSiteUrl;
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
};

const getAbsoluteUrl = (path) => {
  const origin = getSiteOrigin();
  if (!origin) return path;
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
};

const getSeoImage = () => getAbsoluteUrl(DEFAULT_IMAGE_PATH);

const shortAddress = (address = "") =>
  address && address.length > 12
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address;

const makeBreadcrumbSchema = (canonicalUrl, title) => ({
  "@type": "BreadcrumbList",
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      name: SITE_NAME,
      item: getAbsoluteUrl("/"),
    },
    {
      "@type": "ListItem",
      position: 2,
      name: title.replace(` | ${SITE_NAME}`, ""),
      item: canonicalUrl,
    },
  ],
});

const makeJsonLd = ({ title, description, canonicalUrl, imageUrl, type }) => ({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${getAbsoluteUrl("/")}#website`,
      name: SITE_NAME,
      url: getAbsoluteUrl("/"),
      description: DEFAULT_DESCRIPTION,
      inLanguage: "en",
    },
    {
      "@type": "WebApplication",
      "@id": `${getAbsoluteUrl("/")}#app`,
      name: SITE_NAME,
      url: getAbsoluteUrl("/"),
      applicationCategory: "FinanceApplication",
      operatingSystem: "Desktop browser",
      description: DEFAULT_DESCRIPTION,
      inLanguage: "en",
    },
    {
      "@type": type === "article" ? "Article" : "WebPage",
      "@id": `${canonicalUrl}#webpage`,
      name: title,
      headline: title.replace(` | ${SITE_NAME}`, ""),
      url: canonicalUrl,
      description,
      image: imageUrl,
      isPartOf: { "@id": `${getAbsoluteUrl("/")}#website` },
      inLanguage: "en",
    },
    makeBreadcrumbSchema(canonicalUrl, title),
  ],
});

const upsertJsonLd = (data) => {
  const id = "route-seo-jsonld";
  let script = document.getElementById(id);
  if (!script) {
    script = document.createElement("script");
    script.id = id;
    script.type = "application/ld+json";
    document.head.appendChild(script);
  }
  script.textContent = JSON.stringify(data);
};

const PageSeo = ({ page, children }) => {
  const location = useLocation();
  const params = useParams();

  useEffect(() => {
    const baseSeo = PAGE_SEO[page] || PAGE_SEO.home;
    const pathname = location.pathname || "/";
    const canonicalPath = pathname === "/" ? "/" : stripTrailingSlash(pathname);
    const canonicalUrl = getAbsoluteUrl(canonicalPath);
    const addressTitle =
      page === "auctionDetails" && params.address
        ? `Auction ${shortAddress(params.address)} | ${SITE_NAME}`
        : baseSeo.title;
    const title = addressTitle || DEFAULT_TITLE;
    const description = baseSeo.description || DEFAULT_DESCRIPTION;
    const robots = baseSeo.robots || "index,follow";
    const type = baseSeo.type || "website";
    const imageUrl = getSeoImage();

    document.title = title;

    setNamedMeta("description", description);
    setNamedMeta("robots", robots);
    setNamedMeta("googlebot", robots);
    setNamedMeta("application-name", SITE_NAME);
    setNamedMeta("apple-mobile-web-app-title", SITE_NAME);
    setNamedMeta("theme-color", "#103090");
    setNamedMeta("twitter:card", "summary_large_image");
    setNamedMeta("twitter:title", title);
    setNamedMeta("twitter:description", description);
    setNamedMeta("twitter:image", imageUrl);

    setPropertyMeta("og:site_name", SITE_NAME);
    setPropertyMeta("og:title", title);
    setPropertyMeta("og:description", description);
    setPropertyMeta("og:type", type === "article" ? "article" : "website");
    setPropertyMeta("og:url", canonicalUrl);
    setPropertyMeta("og:image", imageUrl);
    setPropertyMeta("og:locale", "en_US");

    setCanonical(canonicalUrl);
    upsertJsonLd(makeJsonLd({ title, description, canonicalUrl, imageUrl, type }));
  }, [location.pathname, page, params.address]);

  return children;
};

export default PageSeo;
