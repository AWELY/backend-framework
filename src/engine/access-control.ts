/**
 * التحكم في الوصول حسب الدور (Role-Based Access Control، واختصاره RBAC).
 *
 * الفكرة: كل دور يملك قائمة صلاحيات، والمسارات تفحص الصلاحية ("products:write")
 * وليس اسم الدور. النتيجة: إضافة دور جديد، أو نقل صلاحية من دور إلى آخر، تعني تعديل
 * هذا الجدول فقط، دون لمس أي مسار.
 *
 * البديل الذي رفضناه: كتابة if (role === "owner") في كل مسار. عندها إضافة دور مثل
 * "موظف" تعني البحث في كل المسارات وتعديلها واحداً واحداً.
 *
 * شكل الصلاحية: "<المورد>:<العملية>"، مثل "orders:create".
 * ويمكن للدور أن يملك:
 *   "*"           : كل شيء (المالك).
 *   "<المورد>:*"  : كل العمليات على مورد واحد، مثل "products:*".
 */

/** صلاحية واحدة، مثل "products:read". */
export type Permission = string;
/** جدول الأدوار: اسم كل دور وقائمة صلاحياته. readonly: لا تُعدَّل القائمة بعد إنشائها. */
export type RolePermissions = Record<string, readonly Permission[]>;

/**
 * السياسة الافتراضية لمتجر صغير. يستطيع المتجر تمرير جدول خاص به بدلها
 * (الخيار accessControl في createCommerceApp).
 *
 * المالك: كل شيء.
 * الزبون:
 *   products:read    : قراءة المنتجات
 *   categories:read  : قراءة الأقسام
 *   cart:manage      : إدارة سلته
 *   orders:create    : إنشاء طلب (إتمام الشراء)
 *   orders:read-own  : قراءة طلباته هو فقط
 *   profile:manage   : تعديل ملفه الشخصي
 */
export const DEFAULT_ROLES: RolePermissions = {
  owner: ["*"],
  customer: [
    "products:read",
    "categories:read",
    "cart:manage",
    "orders:create",
    "orders:read-own",
    "profile:manage",
  ],
};

export class AccessControl {
  constructor(private readonly roles: RolePermissions = DEFAULT_ROLES) {}

  /**
   * هل يملك هذا الدور هذه الصلاحية؟
   * يستخدمها requirePermission في middleware/auth.ts، وبعض الوحدات مباشرة
   * (مثلاً المالك يرى المنتجات غير النشطة، لأنه يملك "products:write").
   *
   * أمثلة مع الجدول الافتراضي:
   *   can("owner", "orders:write")       يعطي true  (لأن عنده "*")
   *   can("customer", "cart:manage")     يعطي true
   *   can("customer", "products:write")  يعطي false
   *   can(undefined, "products:read")    يعطي false (ضيف بلا دور)
   */
  can(role: string | undefined, permission: Permission): boolean {
    // لا دور (ضيف لم يسجل دخوله): لا صلاحيات.
    if (!role) return false;
    const granted = this.roles[role];
    // دور غير معروف في الجدول: لا صلاحيات.
    if (!granted) return false;
    // المورد هو الجزء قبل ":"، مثل "products" من "products:write".
    const resource = permission.split(":")[0];
    // يكفي أن تطابق صلاحية واحدة: "*"، أو الصلاحية نفسها، أو "<المورد>:*".
    return granted.some((p) => p === "*" || p === permission || p === `${resource}:*`);
  }

  /** هل هذا الدور معرّف في الجدول؟ دالة مساعدة عامة للمتاجر، ولا يستخدمها الإطار نفسه اليوم. */
  hasRole(role: string): boolean {
    return role in this.roles;
  }
}
