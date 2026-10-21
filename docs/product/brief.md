# Perpeto build brief

Mission: let an individual build and ship large software projects through sustained, inspectable coordination of existing agent harnesses across machines.

The [living vision](vision.md) is the source for product decisions. The first user is Justus, whose current workflow uses extensive specifications and roughly twenty concurrent agents over multiple days.

The implementation foundation is T3 Code's existing orchestration and every provider integration. Perpeto adds durable factory coordination, cross-device messaging, a configurable visual factory builder, and user-owned CI runners. All inference remains in harnesses.

Start by preserving a runnable upstream foundation and implementing durable messaging state. Subsequent milestones connect that state to authenticated agents and users, then implement factory definitions, execution and CI runners. Native, web, mobile and CLI interfaces are desired; a full release is not implied by the initial foundation.
