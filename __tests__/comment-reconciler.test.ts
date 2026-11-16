/**
 * Comment reconciliation — ad copies of a boosted post.
 *
 * Comments left on an ad carry the ad's own media id, so the sweep has to look
 * at those media too or a webhook Meta never delivers is lost for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, queueAdd, readComments, listMedia } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRaw: vi.fn(),
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  queueAdd: vi.fn(),
  readComments: vi.fn(),
  listMedia: vi.fn(),
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: queueAdd }),
}));
vi.mock("@/lib/instagram/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instagram/provider")>()),
  createInstagramContext: async () => ({
    provider: "META",
    accessToken: "local-test",
  }),
  getRecentMediaComments: readComments,
  getUserMedia: listMedia,
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  adMediaFor,
  adMediaForAccount,
  reconcileComments,
} from "../lib/polling/comment-reconciler";

const POST = "18023946917554990";
const AD = "17899788633163100";

describe("adMediaFor", () => {
  beforeEach(() => {
    mockPrisma.$queryRaw.mockReset();
  });

  it("returns the ad media ids seen for the post", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("never returns the post itself, so it is not swept twice", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { mediaId: AD },
      { mediaId: POST },
    ]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("drops rows without a media id", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { mediaId: null },
      { mediaId: AD },
    ]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("returns nothing when the post was never boosted", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });

  it("swallows a query failure, leaving the post itself still swept", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("connection lost"));
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });
});

describe("adMediaForAccount", () => {
  const AD_DARK = "17900000000000001";

  beforeEach(() => {
    mockPrisma.$queryRaw.mockReset();
  });

  it("returns the ad media ids seen for the account", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { mediaId: AD_DARK, lastSeen: new Date() },
    ]);
    await expect(adMediaForAccount("owner")).resolves.toEqual([AD_DARK]);
  });

  it("drops rows without a media id", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { mediaId: null, lastSeen: new Date() },
      { mediaId: AD_DARK, lastSeen: new Date() },
    ]);
    await expect(adMediaForAccount("owner")).resolves.toEqual([AD_DARK]);
  });

  it("returns nothing when no ad comment ever arrived", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(adMediaForAccount("owner")).resolves.toEqual([]);
  });

  it("swallows a query failure, leaving the published feed still swept", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("connection lost"));
    await expect(adMediaForAccount("owner")).resolves.toEqual([]);
  });
});

describe("all-posts-and-ads campaigns also sweep ad media", () => {
  const AD_DARK = "17900000000000001";

  beforeEach(() => {
    queueAdd.mockReset();
    readComments.mockReset();
    listMedia.mockReset().mockResolvedValue([]);
    mockPrisma.$queryRaw.mockReset().mockResolvedValue([
      { mediaId: AD_DARK, lastSeen: new Date() },
    ]);
    mockPrisma.dmLog.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "campaign-any",
        name: "Formation (all posts & ads)",
        workspaceId: "workspace",
        postId: null,
        matchAnyPost: true,
        matchAnyWord: false,
        keywords: ["FORMATION"],
        wholeWordMatch: true,
        publicReplyEnabled: false,
        instagramAccount: {
          id: "connection",
          instagramId: "owner",
          username: "owner",
          provider: "META",
          accessToken: "test",
          workspaceId: "workspace",
          zernioAccountId: null,
        },
      },
    ]);
    readComments.mockResolvedValue([
      {
        id: "ad-comment-1",
        text: "FORMATION please!",
        from: { id: "reader", username: "reader" },
        timestamp: new Date().toISOString(),
      },
    ]);
  });

  it("enqueues a keyword comment left on a dark-post ad the campaign never targeted", async () => {
    await reconcileComments();

    expect(queueAdd).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({
        commentId: "ad-comment-1",
        mediaId: AD_DARK,
        originalMediaId: undefined,
        source: "POLLING",
      })
    );
  });

  it("does not sweep ad media when the webhook recovery finds none", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await reconcileComments();

    expect(readComments).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

describe("comment polling does not recreate unsafe sends", () => {
  beforeEach(() => {
    queueAdd.mockReset();
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "campaign",
        name: "Campaign",
        workspaceId: "workspace",
        postId: POST,
        matchAnyWord: false,
        keywords: ["AI"],
        publicReplyEnabled: true,
        instagramAccount: {
          id: "connection",
          instagramId: "owner",
          provider: "META",
          accessToken: "test",
        },
      },
    ]);
    readComments.mockResolvedValue([
      {
        id: "old",
        text: "AI",
        from: { id: "reader" },
        timestamp: new Date().toISOString(),
      },
      {
        id: "new",
        text: "AI",
        from: { id: "another-reader" },
        timestamp: new Date().toISOString(),
      },
    ]);
  });
  it.each([
    { status: "FAILED", attempts: 1, dmDeliveryUnconfirmed: true },
    { status: "FAILED", attempts: 3, dmDeliveryUnconfirmed: false },
    {
      status: "FAILED",
      attempts: 1,
      errorMessage: "MetaApiError 1: An unknown error has occurred.",
    },
    { status: "PENDING", attempts: 1, dmDeliveryUnconfirmed: true },
  ])(
    "leaves an unsafe old comment alone while continuing new comments: %j",
    async (state) => {
      mockPrisma.dmLog.findMany.mockResolvedValue([
        { commentId: "old", publicReplySentAt: new Date(), ...state },
      ]);
      await reconcileComments();
      await reconcileComments();
      expect(queueAdd).toHaveBeenCalledTimes(2);
      for (const [, data] of queueAdd.mock.calls)
        expect(data.commentId).toBe("new");
    },
  );
});
