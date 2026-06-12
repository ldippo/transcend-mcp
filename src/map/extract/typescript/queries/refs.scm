; Call sites: bare names and member chains.
(call_expression function: (identifier) @call.callee)
(call_expression function: (member_expression) @call.callee)

; Instantiations.
(new_expression constructor: (identifier) @call.callee)

; Class/interface heritage; unpacked in the extractor (extends vs implements).
(class_heritage) @heritage.clause
(extends_type_clause (type_identifier) @extends.name)

; Type annotations and generic types -> reference edges.
(type_annotation) @reference.annotation
