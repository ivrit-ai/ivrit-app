// ivrit's clustering (IvritDiarizationEngine._identify_speakers_with_optimization)
// with what it calls in scikit-learn (1.6) and SciPy ported along: for each number
// of speakers, AgglomerativeClustering (average linkage on cosine distances, and
// Ward), KMeans (k-means++, ten starts from RandomState(42), Lloyd) and the scores
// it rates them by. Agglomerative trees are SciPy's nn_chain, merges sorted and
// relabeled as linkage() does, cut as sklearn's _hc_cut does (Python's heap order
// and all), so labels come out numbered the same. Arithmetic is in double where
// they use float32 (the prints are float32); a near tie may go the other way.

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "speakers.h"

// ---- numpy's RandomState (MT19937, legacy seeding and doubles) -----------------

typedef struct {
    uint32_t mt[624];
    int i;
} mt19937;

static void mt_seed(mt19937 *r, uint32_t s) {
    r->mt[0] = s;
    for (int i = 1; i < 624; i++) r->mt[i] = 1812433253u * (r->mt[i - 1] ^ (r->mt[i - 1] >> 30)) + (uint32_t) i;
    r->i = 624;
}

static uint32_t mt_next(mt19937 *r) {
    if (r->i >= 624) {
        for (int k = 0; k < 624; k++) {
            uint32_t y = (r->mt[k] & 0x80000000u) | (r->mt[(k + 1) % 624] & 0x7fffffffu);
            r->mt[k] = r->mt[(k + 397) % 624] ^ (y >> 1) ^ (y & 1 ? 0x9908b0dfu : 0);
        }
        r->i = 0;
    }
    uint32_t y = r->mt[r->i++];
    y ^= y >> 11;
    y ^= (y << 7) & 0x9d2c5680u;
    y ^= (y << 15) & 0xefc60000u;
    y ^= y >> 18;
    return y;
}

static double mt_double(mt19937 *r) {
    uint32_t a = mt_next(r) >> 5, b = mt_next(r) >> 6;
    return (a * 67108864.0 + b) / 9007199254740992.0;
}

// ---- agglomerative clustering ----------------------------------------------------

static size_t condensed(size_t n, size_t i, size_t j) {
    if (i > j) {
        size_t t = i;
        i = j;
        j = t;
    }
    return n * i - (i * (i + 1)) / 2 + (j - i - 1);
}

typedef struct {
    double a, b, dist;
    size_t order;
} merge;

static int cmp_merge(const void *x, const void *y) {
    const merge *p = x, *q = y;
    if (p->dist != q->dist) return p->dist < q->dist ? -1 : 1;
    return p->order < q->order ? -1 : p->order > q->order;  // mergesort is stable
}

static size_t uf_find(size_t *parent, size_t x) {
    size_t root = x;
    while (parent[root] != root) root = parent[root];
    while (parent[x] != root) {
        size_t next = parent[x];
        parent[x] = root;
        x = next;
    }
    return root;
}

// scipy's linkage(method='average' | 'ward') on condensed distances `d` (used up):
// children[k] = the two clusters merged k-th, as sklearn reads Z[:, :2].
static bool linkage(double *d, size_t n, bool ward, size_t (*children)[2]) {
    size_t *size = malloc(n * sizeof *size), *chain = malloc(n * sizeof *chain), *parent = malloc(2 * n * sizeof *parent);
    merge *z = malloc((n ? n : 1) * sizeof *z);
    if (!size || !chain || !parent || !z) {
        free(size);
        free(chain);
        free(parent);
        free(z);
        return false;
    }
    for (size_t i = 0; i < n; i++) size[i] = 1;
    size_t length = 0;
    for (size_t k = 0; k + 1 < n; k++) {
        if (length == 0) {
            length = 1;
            for (size_t i = 0; i < n; i++) {
                if (size[i] > 0) {
                    chain[0] = i;
                    break;
                }
            }
        }
        size_t x, y = 0;
        double current;
        for (;;) {
            x = chain[length - 1];
            if (length > 1) {
                y = chain[length - 2];
                current = d[condensed(n, x, y)];
            } else {
                current = INFINITY;
            }
            for (size_t i = 0; i < n; i++) {
                if (size[i] == 0 || x == i) continue;
                double dist = d[condensed(n, x, i)];
                if (dist < current) {
                    current = dist;
                    y = i;
                }
            }
            if (length > 1 && y == chain[length - 2]) break;
            chain[length++] = y;
        }
        length -= 2;
        if (x > y) {
            size_t t = x;
            x = y;
            y = t;
        }
        double nx = (double) size[x], ny = (double) size[y];
        z[k] = (merge) {(double) x, (double) y, current, k};
        size[x] = 0;
        size[y] = (size_t) (nx + ny);
        for (size_t i = 0; i < n; i++) {
            double ni = (double) size[i];
            if (size[i] == 0 || i == y) continue;
            double d_xi = d[condensed(n, i, x)], d_yi = d[condensed(n, i, y)];
            double v;
            if (ward) {
                double t = 1.0 / (nx + ny + ni);
                v = sqrt((ni + nx) * t * d_xi * d_xi + (ni + ny) * t * d_yi * d_yi - ni * t * current * current);
            } else {
                v = (nx * d_xi + ny * d_yi) / (nx + ny);
            }
            d[condensed(n, i, y)] = v;
        }
    }
    if (n > 1) qsort(z, n - 1, sizeof *z, cmp_merge);
    // scipy's label(): each merge's clusters by their union-find roots, in order.
    for (size_t i = 0; i < 2 * n; i++) parent[i] = i;
    size_t next = n;
    for (size_t k = 0; k + 1 < n; k++) {
        size_t xr = uf_find(parent, (size_t) z[k].a), yr = uf_find(parent, (size_t) z[k].b);
        children[k][0] = xr < yr ? xr : yr;
        children[k][1] = xr < yr ? yr : xr;
        parent[xr] = parent[yr] = next++;
    }
    free(size);
    free(chain);
    free(parent);
    free(z);
    return true;
}

// Python's heapq on ints (a min-heap of negated node ids, as _hc_cut keeps it).
static void sift_down(long *h, size_t start, size_t pos) {
    long item = h[pos];
    while (pos > start) {
        size_t parent = (pos - 1) >> 1;
        if (item < h[parent]) {
            h[pos] = h[parent];
            pos = parent;
            continue;
        }
        break;
    }
    h[pos] = item;
}

static void sift_up(long *h, size_t n, size_t pos) {
    size_t start = pos;
    long item = h[pos];
    size_t child = 2 * pos + 1;
    while (child < n) {
        size_t right = child + 1;
        if (right < n && !(h[child] < h[right])) child = right;
        h[pos] = h[child];
        pos = child;
        child = 2 * pos + 1;
    }
    h[pos] = item;
    sift_down(h, start, pos);
}

// sklearn's _hc_cut: the tree cut into k clusters, labels by heap position.
static bool hc_cut(size_t k, size_t (*children)[2], size_t n, int *labels) {
    long *heap = malloc((k + 1) * sizeof *heap);
    size_t *stack = malloc(2 * n * sizeof *stack);
    if (!heap || !stack) {
        free(heap);
        free(stack);
        return false;
    }
    size_t len = 1;
    if (n == 1) {
        labels[0] = 0;
        free(heap);
        free(stack);
        return true;
    }
    size_t top = children[n - 2][0] > children[n - 2][1] ? children[n - 2][0] : children[n - 2][1];
    heap[0] = -(long) (top + 1);
    for (size_t c = 0; c + 1 < k; c++) {
        size_t *these = children[(size_t) (-heap[0]) - n];
        heap[len++] = -(long) these[0];  // heappush
        sift_down(heap, 0, len - 1);
        long item = -(long) these[1];  // heappushpop
        if (len && heap[0] < item) {
            long t = heap[0];
            heap[0] = item;
            item = t;
            sift_up(heap, len, 0);
        }
    }
    for (size_t i = 0; i < len; i++) {
        size_t sp = 0;
        stack[sp++] = (size_t) (-heap[i]);
        while (sp) {
            size_t node = stack[--sp];
            if (node < n) {
                labels[node] = (int) i;
            } else {
                stack[sp++] = children[node - n][0];
                stack[sp++] = children[node - n][1];
            }
        }
    }
    free(heap);
    free(stack);
    return true;
}

// ---- k-means ---------------------------------------------------------------------

static double sqdist(const double *a, const double *b, size_t dim) {
    double s = 0;
    for (size_t j = 0; j < dim; j++) {
        double t = a[j] - b[j];
        s += t * t;
    }
    return s;
}

// _kmeans_plusplus with n_local_trials = 2 + log(k), unit weights.
static void kmeans_pp(const double *x, size_t n, size_t dim, size_t k, mt19937 *rng, double *centers, double *closest,
                      double *trial) {
    size_t trials = 2 + (size_t) log((double) k);
    // RandomState.choice(n, p=w/w.sum()): the cdf (of float32 1/n), over its last, searched side right.
    double u = mt_double(rng), step = (double) (1.0f / (float) n), total = step * (double) n, cum = 0;
    size_t first = n - 1;
    double *cdf = malloc(n * sizeof *cdf);
    if (!cdf) return;
    for (size_t i = 0; i < n; i++) cdf[i] = cum += step;
    total = cdf[n - 1];
    for (size_t i = 0; i < n; i++) {
        if (cdf[i] / total > u) {
            first = i;
            break;
        }
    }
    free(cdf);
    memcpy(centers, x + first * dim, dim * sizeof *x);
    double pot = 0;
    for (size_t i = 0; i < n; i++) pot += closest[i] = sqdist(x + i * dim, centers, dim);
    size_t *candidates = malloc(trials * sizeof *candidates);
    double *cumsum = malloc(n * sizeof *cumsum);
    if (!candidates || !cumsum) {
        free(candidates);
        free(cumsum);
        return;
    }
    for (size_t c = 1; c < k; c++) {
        double s = 0;
        for (size_t i = 0; i < n; i++) cumsum[i] = s += closest[i];
        for (size_t t = 0; t < trials; t++) {
            double v = mt_double(rng) * pot;
            size_t lo = 0, hi = n;  // searchsorted, side left
            while (lo < hi) {
                size_t mid = (lo + hi) / 2;
                if (cumsum[mid] < v) lo = mid + 1;
                else hi = mid;
            }
            candidates[t] = lo < n ? lo : n - 1;
        }
        size_t best = 0;
        double best_pot = INFINITY;
        for (size_t t = 0; t < trials; t++) {
            double p = 0;
            for (size_t i = 0; i < n; i++) {
                double dd = sqdist(x + i * dim, x + candidates[t] * dim, dim);
                trial[t * n + i] = dd < closest[i] ? dd : closest[i];
                p += trial[t * n + i];
            }
            if (p < best_pot) {
                best_pot = p;
                best = t;
            }
        }
        pot = best_pot;
        memcpy(closest, trial + best * n, n * sizeof *closest);
        memcpy(centers + c * dim, x + candidates[best] * dim, dim * sizeof *x);
    }
    free(candidates);
    free(cumsum);
}

static void assign(const double *x, size_t n, size_t dim, const double *centers, size_t k, int *labels) {
    for (size_t i = 0; i < n; i++) {
        size_t best = 0;
        double best_d = INFINITY;
        for (size_t c = 0; c < k; c++) {
            // ||c||^2 - 2 x.c, as sklearn ranks centers.
            double cc = 0, xc = 0;
            for (size_t j = 0; j < dim; j++) {
                cc += centers[c * dim + j] * centers[c * dim + j];
                xc += x[i * dim + j] * centers[c * dim + j];
            }
            double v = cc - 2 * xc;
            if (v < best_d) {
                best_d = v;
                best = c;
            }
        }
        labels[i] = (int) best;
    }
}

static bool same_clustering(const int *a, const int *b, size_t n, size_t k) {
    int *map = malloc(k * sizeof *map);
    if (!map) return false;
    for (size_t c = 0; c < k; c++) map[c] = -1;
    bool same = true;
    for (size_t i = 0; i < n && same; i++) {
        if (map[a[i]] == -1) map[a[i]] = b[i];
        else if (map[a[i]] != b[i]) same = false;
    }
    free(map);
    return same;
}

// KMeans(k, random_state=42, n_init=10).fit(x).labels_ (x centered, as fit does).
static bool kmeans(const double *x, size_t n, size_t dim, size_t k, double tol, mt19937 *rng, int *out) {
    double *centers = malloc(k * dim * sizeof *centers), *next = malloc(k * dim * sizeof *next);
    double *closest = malloc(n * sizeof *closest), *trial = malloc((3 + (size_t) log((double) k)) * n * sizeof *trial);
    double *weight = malloc(k * sizeof *weight), *far = malloc(n * sizeof *far);
    int *labels = malloc(n * sizeof *labels), *old = malloc(n * sizeof *old);
    bool ok = centers && next && closest && trial && weight && far && labels && old;
    double best_inertia = INFINITY;
    bool have_best = false;
    for (int start = 0; ok && start < 10; start++) {
        kmeans_pp(x, n, dim, k, rng, centers, closest, trial);
        for (size_t i = 0; i < n; i++) old[i] = labels[i] = -1;
        bool strict = false;
        for (int iter = 0; iter < 300; iter++) {
            assign(x, n, dim, centers, k, labels);
            memset(next, 0, k * dim * sizeof *next);
            memset(weight, 0, k * sizeof *weight);
            for (size_t i = 0; i < n; i++) {
                weight[labels[i]] += 1;
                for (size_t j = 0; j < dim; j++) next[labels[i] * dim + j] += x[i * dim + j];
            }
            // _relocate_empty_clusters_dense: the points farthest from their centers.
            size_t empty = 0;
            for (size_t c = 0; c < k; c++) empty += weight[c] == 0;
            if (empty) {
                for (size_t i = 0; i < n; i++) far[i] = sqdist(x + i * dim, centers + labels[i] * dim, dim);
                for (size_t c = 0; c < k; c++) {
                    if (weight[c] != 0) continue;
                    size_t f = 0;
                    for (size_t i = 1; i < n; i++) {
                        if (far[i] > far[f]) f = i;
                    }
                    far[f] = -1;
                    size_t from = (size_t) labels[f];
                    for (size_t j = 0; j < dim; j++) {
                        next[from * dim + j] -= x[f * dim + j];
                        next[c * dim + j] = x[f * dim + j];
                    }
                    weight[c] = 1;
                    weight[from] -= 1;
                }
            }
            double shift = 0;
            for (size_t c = 0; c < k; c++) {
                for (size_t j = 0; j < dim; j++) {
                    if (weight[c] > 0) next[c * dim + j] /= weight[c];
                }
                shift += sqdist(next + c * dim, centers + c * dim, dim);
            }
            double *t = centers;
            centers = next;
            next = t;
            if (memcmp(labels, old, n * sizeof *labels) == 0) {
                strict = true;
                break;
            }
            if (shift <= tol) break;
            memcpy(old, labels, n * sizeof *labels);
        }
        if (!strict) assign(x, n, dim, centers, k, labels);
        double inertia = 0;
        for (size_t i = 0; i < n; i++) inertia += sqdist(x + i * dim, centers + labels[i] * dim, dim);
        if (!have_best || (inertia < best_inertia && !same_clustering(labels, out, n, k))) {
            memcpy(out, labels, n * sizeof *out);
            best_inertia = inertia;
            have_best = true;
        }
    }
    free(centers);
    free(next);
    free(closest);
    free(trial);
    free(weight);
    free(far);
    free(labels);
    free(old);
    return ok;
}

// ---- the scores (_calculate_clustering_metrics, _calculate_composite_score) -----

// silhouette (cosine distances `cd`, n x n), Calinski-Harabasz and Davies-Bouldin
// (euclidean) combined; 0.1 where they cannot be had (one cluster, or one a point).
static double composite(const double *x, const double *cd, size_t n, size_t dim, const int *labels, size_t k) {
    size_t used = 0;
    size_t *count = calloc(k, sizeof *count);
    double *centroid = calloc(k * dim, sizeof *centroid), *sums = malloc(k * sizeof *sums);
    double *intra = calloc(k, sizeof *intra), mean[SP_DIM] = {0};
    double score = 0.1;
    if (!count || !centroid || !sums || !intra || dim > SP_DIM) goto done;
    for (size_t i = 0; i < n; i++) count[labels[i]]++;
    for (size_t c = 0; c < k; c++) used += count[c] > 0;
    if (used < 2 || used > n - 1) goto done;
    // Silhouette: each point's mean distance to its own cluster against the nearest other.
    double sil = 0;
    for (size_t i = 0; i < n; i++) {
        for (size_t c = 0; c < k; c++) sums[c] = 0;
        for (size_t j = 0; j < n; j++) sums[labels[j]] += cd[i * n + j];
        size_t own = (size_t) labels[i];
        if (count[own] < 2) continue;  // 0/0: nan, counted as 0
        double a = sums[own] / (double) (count[own] - 1), b = INFINITY;
        for (size_t c = 0; c < k; c++) {
            if (c != own && count[c] > 0 && sums[c] / (double) count[c] < b) b = sums[c] / (double) count[c];
        }
        double m = a > b ? a : b;
        if (m > 0) sil += (b - a) / m;
    }
    sil /= (double) n;
    for (size_t i = 0; i < n; i++) {
        for (size_t j = 0; j < dim; j++) {
            centroid[labels[i] * dim + j] += x[i * dim + j];
            mean[j] += x[i * dim + j];
        }
    }
    for (size_t j = 0; j < dim; j++) mean[j] /= (double) n;
    for (size_t c = 0; c < k; c++) {
        for (size_t j = 0; j < dim && count[c]; j++) centroid[c * dim + j] /= (double) count[c];
    }
    double extra = 0, within = 0;
    for (size_t c = 0; c < k; c++) {
        if (count[c]) extra += (double) count[c] * sqdist(centroid + c * dim, mean, dim);
    }
    for (size_t i = 0; i < n; i++) {
        double dd = sqdist(x + i * dim, centroid + labels[i] * dim, dim);
        within += dd;
        intra[labels[i]] += sqrt(dd);
    }
    double ch = within == 0 ? 1.0 : extra * (double) (n - used) / (within * ((double) used - 1.0));
    // Davies-Bouldin, over the clusters that have points.
    bool intra_zero = true, centroids_zero = true;
    for (size_t c = 0; c < k; c++) {
        if (!count[c]) continue;
        intra[c] /= (double) count[c];
        if (fabs(intra[c]) > 1e-8) intra_zero = false;
    }
    for (size_t a = 0; a < k; a++) {
        for (size_t b = 0; b < k && count[a]; b++) {
            if (count[b] && sqrt(sqdist(centroid + a * dim, centroid + b * dim, dim)) > 1e-8) centroids_zero = false;
        }
    }
    double db = 0;
    if (!intra_zero && !centroids_zero) {
        for (size_t a = 0; a < k; a++) {
            if (!count[a]) continue;
            double worst = -INFINITY;
            for (size_t b = 0; b < k; b++) {
                if (!count[b]) continue;
                double dist = sqrt(sqdist(centroid + a * dim, centroid + b * dim, dim));
                double v = (intra[a] + intra[b]) / (dist == 0 ? INFINITY : dist);
                if (v > worst) worst = v;
            }
            db += worst;
        }
        db /= (double) used;
    }
    score = 0.6 * ((sil + 1) / 2) + 0.2 * (1 / (1 + db)) + 0.2 * (1 / (1 + exp(-ch / 1000)));
done:
    free(count);
    free(centroid);
    free(sums);
    free(intra);
    return score;
}

int sp_cluster(const float *prints, const bool *clustered, const bool *missing, size_t n, int *labels,
               sp_progress progress, void *user) {
    const size_t dim = SP_DIM;
    size_t m = 0;
    for (size_t i = 0; i < n; i++) m += clustered[i] && !missing[i];
    for (size_t i = 0; i < n; i++) labels[i] = -1;
    if (m == 0) return 0;
    double *x = malloc(m * dim * sizeof *x), *xc = malloc(m * dim * sizeof *xc);
    double *cd = malloc(m * m * sizeof *cd);
    double *dc = malloc((m * (m - 1) / 2 + 1) * sizeof *dc), *de = malloc((m * (m - 1) / 2 + 1) * sizeof *de);
    size_t (*tree_cos)[2] = malloc((m ? m : 1) * sizeof *tree_cos), (*tree_ward)[2] = malloc((m ? m : 1) * sizeof *tree_ward);
    int *cand = malloc(m * sizeof *cand), *best = malloc(m * sizeof *best);
    double *centroid = calloc(SP_MAX_SPEAKERS * dim, sizeof *centroid);
    int result = -1;
    if (!x || !xc || !cd || !dc || !de || !tree_cos || !tree_ward || !cand || !best || !centroid) goto done;
    size_t at = 0;
    for (size_t i = 0; i < n; i++) {
        if (!clustered[i] || missing[i]) continue;
        for (size_t j = 0; j < dim; j++) x[at * dim + j] = prints[i * dim + j];
        at++;
    }
    // Cosine distances (sklearn's: of unit rows, clipped to [0, 2]); scipy's pdist alike.
    double *unit = xc;
    for (size_t i = 0; i < m; i++) {
        double norm = sqrt(sqdist(x + i * dim, (double[SP_DIM]) {0}, dim));
        for (size_t j = 0; j < dim; j++) unit[i * dim + j] = norm > 0 ? x[i * dim + j] / norm : 0;
    }
    for (size_t i = 0; i < m; i++) {
        for (size_t j = 0; j < m; j++) {
            double s = 0;
            for (size_t t = 0; t < dim; t++) s += unit[i * dim + t] * unit[j * dim + t];
            double v = 1 - s;
            cd[i * m + j] = v < 0 ? 0 : v > 2 ? 2 : v;
        }
    }
    for (size_t i = 0; i < m; i++) {
        for (size_t j = i + 1; j < m; j++) {
            dc[condensed(m, i, j)] = cd[i * m + j];
            de[condensed(m, i, j)] = sqrt(sqdist(x + i * dim, x + j * dim, dim));
        }
    }
    if (!linkage(dc, m, false, tree_cos) || !linkage(de, m, true, tree_ward)) goto done;
    if (progress) progress(0.1, user);
    // KMeans' copy, centered, and its tolerance: 1e-4 of the mean variance.
    double meanv[SP_DIM] = {0}, var = 0;
    for (size_t i = 0; i < m; i++) {
        for (size_t j = 0; j < dim; j++) meanv[j] += x[i * dim + j] / (double) m;
    }
    for (size_t i = 0; i < m; i++) {
        for (size_t j = 0; j < dim; j++) {
            xc[i * dim + j] = x[i * dim + j] - meanv[j];
            var += xc[i * dim + j] * xc[i * dim + j];
        }
    }
    double tol = 1e-4 * var / (double) (m * dim);
    size_t most = m < SP_MAX_SPEAKERS ? m : SP_MAX_SPEAKERS;
    double best_score = -1;
    size_t best_k = 1;
    for (size_t k = 1; k <= most; k++) {
        for (int method = 0; method < 3; method++) {
            bool ok;
            if (method == 0) ok = hc_cut(k, tree_cos, m, cand);
            else if (method == 1) {
                mt19937 rng;
                mt_seed(&rng, 42);
                ok = kmeans(xc, m, dim, k, tol, &rng, cand);
            } else ok = hc_cut(k, tree_ward, m, cand);
            if (!ok) goto done;
            double score = composite(x, cd, m, dim, cand, k);
            if (score > best_score) {
                best_score = score;
                best_k = k;
                memcpy(best, cand, m * sizeof *best);
            }
        }
        if (progress) progress(0.1 + 0.9 * (double) k / (double) most, user);
    }
    // _assign_speakers_to_all_segments: every print to its closest centroid (cosine).
    size_t count[SP_MAX_SPEAKERS] = {0};
    for (size_t i = 0; i < m; i++) {
        count[best[i]]++;
        for (size_t j = 0; j < dim; j++) centroid[best[i] * dim + j] += x[i * dim + j];
    }
    for (size_t c = 0; c < best_k; c++) {
        double norm = 0;
        for (size_t j = 0; j < dim; j++) {
            if (count[c]) centroid[c * dim + j] /= (double) count[c];
            norm += centroid[c * dim + j] * centroid[c * dim + j];
        }
        norm = sqrt(norm);
        for (size_t j = 0; j < dim; j++) centroid[c * dim + j] = norm > 0 ? centroid[c * dim + j] / norm : 0;
    }
    for (size_t i = 0; i < n; i++) {
        if (missing[i]) continue;
        double norm = 0;
        for (size_t j = 0; j < dim; j++) norm += (double) prints[i * dim + j] * prints[i * dim + j];
        norm = sqrt(norm);
        int pick = -1;
        double top = -INFINITY;
        for (size_t c = 0; c < best_k; c++) {
            if (!count[c]) continue;
            double s = 0;
            for (size_t j = 0; j < dim; j++) s += (norm > 0 ? prints[i * dim + j] / norm : 0) * centroid[c * dim + j];
            if (s > top) {
                top = s;
                pick = (int) c;
            }
        }
        labels[i] = pick;
    }
    result = (int) best_k;
done:
    free(x);
    free(xc);
    free(cd);
    free(dc);
    free(de);
    free(tree_cos);
    free(tree_ward);
    free(cand);
    free(best);
    free(centroid);
    return result;
}
